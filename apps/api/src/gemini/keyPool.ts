import type { ApiKeyStatus, ApiKeyTestResult, KeyPoolSettings, KeyStrategy } from '@aiedit/shared';
import { DEFAULT_KEY_POOL_SETTINGS } from '@aiedit/shared';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { query, queryOne } from '../db/pool';
import { Semaphore, sleep } from '../utils/async';
import { decryptSecret } from '../utils/crypto';
import { serviceUnavailable } from '../utils/errors';
import { GeminiClient } from './client';
import { GeminiError } from './types';

export interface KeyRow {
  id: string;
  user_id: string;
  name: string;
  encrypted_key: string;
  masked_key: string;
  enabled: boolean;
  priority: number;
  status: ApiKeyStatus;
  request_count: string;
  failure_count: number;
  cooldown_until: Date | null;
  last_used_at: Date | null;
}

export interface LeasedKey {
  id: string | null;
  name: string;
  client: GeminiClient;
}

/** Per-key concurrency limiters, shared across the process. */
const semaphores = new Map<string, Semaphore>();

function semaphoreFor(keyId: string, permits: number): Semaphore {
  let sem = semaphores.get(keyId);
  if (!sem) {
    sem = new Semaphore(permits);
    semaphores.set(keyId, sem);
  }
  return sem;
}

/** Round-robin cursor per user, so load-balance mode actually spreads out. */
const rrCursor = new Map<string, number>();

export async function getKeyPoolSettings(userId: string): Promise<KeyPoolSettings> {
  const row = await queryOne<{ key_pool_settings: Partial<KeyPoolSettings> }>(
    'SELECT key_pool_settings FROM users WHERE id = $1',
    [userId],
  );
  return { ...DEFAULT_KEY_POOL_SETTINGS, ...(row?.key_pool_settings ?? {}) };
}

export async function setKeyPoolSettings(
  userId: string,
  settings: KeyPoolSettings,
): Promise<KeyPoolSettings> {
  await query('UPDATE users SET key_pool_settings = $2 WHERE id = $1', [
    userId,
    JSON.stringify(settings),
  ]);
  return settings;
}

/** Keys eligible to serve traffic right now, in the order they should be tried. */
async function loadCandidates(userId: string, strategy: KeyStrategy): Promise<KeyRow[]> {
  const rows = await query<KeyRow>(
    `SELECT id, user_id, name, encrypted_key, masked_key, enabled, priority, status,
            request_count, failure_count, cooldown_until, last_used_at
       FROM api_keys
      WHERE user_id = $1
        AND enabled = true
        AND status NOT IN ('invalid', 'blocked', 'expired')
        AND (cooldown_until IS NULL OR cooldown_until <= now())
      ORDER BY priority ASC, created_at ASC`,
    [userId],
  );

  if (strategy !== 'load_balance' || rows.length <= 1) return rows;

  // Load balancing: rotate the starting point and prefer the least recently
  // used key, so bursts fan out instead of hammering the highest-priority key.
  const start = (rrCursor.get(userId) ?? 0) % rows.length;
  rrCursor.set(userId, start + 1);
  const rotated = [...rows.slice(start), ...rows.slice(0, start)];
  return rotated.sort((a, b) => {
    const aUsed = a.last_used_at?.getTime() ?? 0;
    const bUsed = b.last_used_at?.getTime() ?? 0;
    return aUsed - bUsed;
  });
}

async function recordEvent(params: {
  keyId: string;
  event: string;
  statusCode?: number | null;
  latencyMs?: number | null;
  model?: string | null;
  detail?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO api_key_events (api_key_id, event, status_code, latency_ms, model, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.keyId,
      params.event,
      params.statusCode ?? null,
      params.latencyMs ?? null,
      params.model ?? null,
      params.detail ? params.detail.slice(0, 1000) : null,
    ],
  ).catch((err) => logger.warn({ err }, 'Failed to record API key event'));
}

async function markSuccess(keyId: string, latencyMs: number, model: string): Promise<void> {
  await query(
    `UPDATE api_keys
        SET request_count = request_count + 1,
            failure_count = 0,
            last_used_at = now(),
            response_time_ms = $2,
            status = CASE WHEN status IN ('rate_limited','quota_exceeded','error','untested')
                          THEN 'valid' ELSE status END,
            status_message = NULL,
            cooldown_until = NULL
      WHERE id = $1`,
    [keyId, Math.round(latencyMs)],
  );
  await recordEvent({ keyId, event: 'success', latencyMs, model });
}

async function markFailure(
  keyId: string,
  err: GeminiError,
  cooldownSeconds: number,
  model: string,
): Promise<void> {
  const status = err.toKeyStatus();
  // Rate limits and quota exhaustion are transient: bench the key, don't kill
  // it. Auth/permission failures disable it until the user intervenes.
  const cooldownMs =
    err.failureClass === 'rate_limit'
      ? (err.retryAfterMs ?? cooldownSeconds * 1000)
      : err.failureClass === 'quota'
        ? Math.max(cooldownSeconds * 1000, 15 * 60 * 1000)
        : 0;

  await query(
    `UPDATE api_keys
        SET failure_count = failure_count + 1,
            last_used_at = now(),
            status = $2,
            status_message = $3,
            cooldown_until = CASE WHEN $4::int > 0 THEN now() + ($4::int || ' milliseconds')::interval
                                  ELSE cooldown_until END
      WHERE id = $1`,
    [keyId, status, err.message.slice(0, 500), cooldownMs],
  );
  await recordEvent({
    keyId,
    event: `failure:${err.failureClass}`,
    statusCode: err.statusCode,
    model,
    detail: err.message,
  });
}

export interface RunOptions {
  userId: string;
  /** Used purely for logs and key-event attribution. */
  model: string;
  /** Skip these key ids (e.g. a long-running operation must stay on one key). */
  pinnedKeyId?: string | null;
  label?: string;
}

export interface RunResult<T> {
  value: T;
  keyId: string | null;
  keyName: string;
}

/**
 * Execute `fn` against the user's Gemini key pool.
 *
 * The pool walks candidate keys in priority (or round-robin) order. A failure
 * blamed on the key moves straight to the next one; a transient upstream
 * failure is retried on the same key with backoff. When every key is exhausted
 * the last error is surfaced.
 */
export async function runWithKey<T>(
  options: RunOptions,
  fn: (client: GeminiClient, key: LeasedKey) => Promise<T>,
): Promise<RunResult<T>> {
  const settings = await getKeyPoolSettings(options.userId);

  let candidates: KeyRow[];
  if (options.pinnedKeyId) {
    const pinned = await queryOne<KeyRow>(
      `SELECT id, user_id, name, encrypted_key, masked_key, enabled, priority, status,
              request_count, failure_count, cooldown_until, last_used_at
         FROM api_keys WHERE id = $1 AND user_id = $2`,
      [options.pinnedKeyId, options.userId],
    );
    candidates = pinned ? [pinned] : [];
  } else {
    candidates = await loadCandidates(options.userId, settings.strategy);
  }

  // A process-wide fallback key keeps demos and self-hosted single-tenant
  // installs working before the user has added any key of their own.
  if (candidates.length === 0) {
    if (!env.GEMINI_FALLBACK_API_KEY) {
      throw serviceUnavailable(
        'No usable Gemini API key. Add a key in API Management, or re-enable a disabled key.',
      );
    }
    const client = new GeminiClient(env.GEMINI_FALLBACK_API_KEY);
    const value = await fn(client, { id: null, name: 'environment fallback', client });
    return { value, keyId: null, keyName: 'environment fallback' };
  }

  let lastError: unknown;

  for (const row of candidates) {
    const client = new GeminiClient(decryptSecret(row.encrypted_key));
    const release = await semaphoreFor(row.id, settings.maxConcurrentPerKey).acquire();

    try {
      for (let attempt = 1; attempt <= settings.maxRetries; attempt += 1) {
        const started = Date.now();
        try {
          const value = await fn(client, { id: row.id, name: row.name, client });
          await markSuccess(row.id, Date.now() - started, options.model);
          return { value, keyId: row.id, keyName: row.name };
        } catch (err) {
          lastError = err;

          if (!(err instanceof GeminiError)) throw err;

          if (err.keyAtFault) {
            await markFailure(row.id, err, settings.cooldownSeconds, options.model);
            logger.warn(
              { keyId: row.id, keyName: row.name, failureClass: err.failureClass, label: options.label },
              'Gemini key failed over',
            );
            break; // move to the next key
          }

          if (!err.retryable || attempt === settings.maxRetries) {
            await recordEvent({
              keyId: row.id,
              event: `error:${err.failureClass}`,
              statusCode: err.statusCode,
              model: options.model,
              detail: err.message,
            });
            if (!err.retryable) throw err;
            break;
          }

          const delay = err.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** (attempt - 1));
          logger.debug({ attempt, delay, label: options.label }, 'Retrying Gemini call');
          await sleep(delay);
        }
      }
    } finally {
      release();
    }
  }

  if (lastError instanceof GeminiError) throw lastError;
  if (lastError) throw lastError;
  throw serviceUnavailable('Every Gemini API key in the pool failed. Check API Management.');
}

/**
 * Live validity probe for the "Test API" button: a real `listModels` call plus
 * a tiny `generateContent` round trip so quota problems surface too.
 */
export async function testApiKey(keyId: string, userId: string): Promise<ApiKeyTestResult> {
  const row = await queryOne<KeyRow>(
    `SELECT id, user_id, name, encrypted_key, masked_key, enabled, priority, status,
            request_count, failure_count, cooldown_until, last_used_at
       FROM api_keys WHERE id = $1 AND user_id = $2`,
    [keyId, userId],
  );
  if (!row) throw serviceUnavailable('API key not found');

  const client = new GeminiClient(decryptSecret(row.encrypted_key));
  const startedAt = new Date().toISOString();
  const started = Date.now();

  let status: ApiKeyStatus = 'valid';
  let message = 'Key is valid and responding.';
  let models: string[] = [];
  let ok = true;

  try {
    const { models: found, latencyMs } = await client.listModels();
    models = found
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((name) => !name.includes('embedding'))
      .sort();

    // listModels succeeds even on quota-exhausted keys, so do a 1-token
    // generation to prove the key can actually produce content.
    await client.generateContent(
      env.GEMINI_TEXT_MODEL,
      {
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 8, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      },
      20_000,
    );

    message = `Key is valid. ${models.length} models available, responded in ${latencyMs}ms.`;
  } catch (err) {
    ok = false;
    if (err instanceof GeminiError) {
      status = err.toKeyStatus();
      message = err.message;
      // A quota/rate error still proves the key itself is genuine.
      if (err.failureClass === 'quota') message = `Quota exceeded: ${err.message}`;
      if (err.failureClass === 'rate_limit') message = `Rate limited: ${err.message}`;
    } else {
      status = 'error';
      message = err instanceof Error ? err.message : String(err);
    }
  }

  const responseTimeMs = Date.now() - started;

  await query(
    `UPDATE api_keys
        SET status = $2,
            status_message = $3,
            last_tested_at = now(),
            response_time_ms = $4,
            available_models = $5,
            cooldown_until = CASE WHEN $2 IN ('valid') THEN NULL ELSE cooldown_until END
      WHERE id = $1`,
    [keyId, status, message.slice(0, 500), responseTimeMs, JSON.stringify(models)],
  );
  await recordEvent({ keyId, event: `test:${status}`, latencyMs: responseTimeMs, detail: message });

  return { keyId, status, ok, message, responseTimeMs, availableModels: models, testedAt: startedAt };
}

/** Clear the in-memory semaphores for a deleted key. */
export function forgetKey(keyId: string): void {
  semaphores.delete(keyId);
}
