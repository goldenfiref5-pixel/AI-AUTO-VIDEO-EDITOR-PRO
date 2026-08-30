import type { ApiKeyRecord } from '@aiedit/shared';
import { query, queryOne, withTransaction } from '../db/pool';
import { forgetKey } from '../gemini/keyPool';
import { badRequest, conflict, notFound } from '../utils/errors';
import { encryptSecret, fingerprint, maskSecret } from '../utils/crypto';
import { mapApiKey } from './mappers';

const COLUMNS = `id, user_id, name, masked_key, enabled, priority, status, status_message,
                 last_tested_at, last_used_at, response_time_ms, available_models,
                 request_count, failure_count, cooldown_until, created_at`;

export async function listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
  const rows = await query(
    `SELECT ${COLUMNS} FROM api_keys WHERE user_id = $1 ORDER BY priority ASC, created_at ASC`,
    [userId],
  );
  return rows.map(mapApiKey);
}

export async function createApiKey(params: {
  userId: string;
  name: string;
  key: string;
  priority?: number;
  enabled?: boolean;
}): Promise<ApiKeyRecord> {
  const raw = params.key.trim();
  if (!raw) throw badRequest('The API key cannot be empty.');

  const print = fingerprint(raw);
  const existing = await queryOne<{ name: string }>(
    'SELECT name FROM api_keys WHERE user_id = $1 AND key_fingerprint = $2',
    [params.userId, print],
  );
  if (existing) {
    throw conflict(`This key is already saved as "${existing.name}".`);
  }

  // New keys land at the end of the priority order unless told otherwise.
  const priority =
    params.priority ??
    Number(
      (
        await queryOne<{ next: string }>(
          'SELECT COALESCE(MAX(priority) + 1, 0)::text AS next FROM api_keys WHERE user_id = $1',
          [params.userId],
        )
      )?.next ?? 0,
    );

  const row = await queryOne(
    `INSERT INTO api_keys (user_id, name, encrypted_key, key_fingerprint, masked_key, priority, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${COLUMNS}`,
    [
      params.userId,
      params.name,
      encryptSecret(raw),
      print,
      maskSecret(raw),
      priority,
      params.enabled ?? true,
    ],
  );
  return mapApiKey(row!);
}

export async function updateApiKey(
  keyId: string,
  userId: string,
  update: { name?: string; enabled?: boolean; priority?: number },
): Promise<ApiKeyRecord> {
  const row = await queryOne(
    `UPDATE api_keys SET
       name = COALESCE($3, name),
       enabled = COALESCE($4, enabled),
       priority = COALESCE($5, priority),
       -- Re-enabling a key clears its cooldown so it is eligible immediately.
       cooldown_until = CASE WHEN $4 IS TRUE THEN NULL ELSE cooldown_until END
     WHERE id = $1 AND user_id = $2
     RETURNING ${COLUMNS}`,
    [keyId, userId, update.name ?? null, update.enabled ?? null, update.priority ?? null],
  );
  if (!row) throw notFound('API key not found');
  return mapApiKey(row);
}

export async function deleteApiKey(keyId: string, userId: string): Promise<void> {
  const result = await query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id', [
    keyId,
    userId,
  ]);
  if (result.length === 0) throw notFound('API key not found');
  forgetKey(keyId);
}

/** Persist a drag-and-drop reorder of the failover chain. */
export async function reorderApiKeys(userId: string, keyIds: string[]): Promise<ApiKeyRecord[]> {
  const existing = await listApiKeys(userId);
  const known = new Set(existing.map((k) => k.id));
  for (const id of keyIds) {
    if (!known.has(id)) throw badRequest('The reorder request references a key that does not exist.');
  }
  if (keyIds.length !== existing.length) {
    throw badRequest('The reorder request must list every key exactly once.');
  }

  await withTransaction(async (client) => {
    for (let i = 0; i < keyIds.length; i += 1) {
      await client.query('UPDATE api_keys SET priority = $3 WHERE id = $1 AND user_id = $2', [
        keyIds[i],
        userId,
        i,
      ]);
    }
  });

  return listApiKeys(userId);
}

export interface KeyEvent {
  event: string;
  statusCode: number | null;
  latencyMs: number | null;
  model: string | null;
  detail: string | null;
  createdAt: string;
}

export async function listKeyEvents(keyId: string, userId: string, limit = 50): Promise<KeyEvent[]> {
  const owns = await queryOne('SELECT id FROM api_keys WHERE id = $1 AND user_id = $2', [keyId, userId]);
  if (!owns) throw notFound('API key not found');

  const rows = await query<{
    event: string;
    status_code: number | null;
    latency_ms: number | null;
    model: string | null;
    detail: string | null;
    created_at: Date;
  }>(
    `SELECT event, status_code, latency_ms, model, detail, created_at
       FROM api_key_events WHERE api_key_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [keyId, limit],
  );

  return rows.map((row) => ({
    event: row.event,
    statusCode: row.status_code,
    latencyMs: row.latency_ms,
    model: row.model,
    detail: row.detail,
    createdAt: row.created_at.toISOString(),
  }));
}

export interface KeyPoolHealth {
  total: number;
  enabled: number;
  usable: number;
  coolingDown: number;
  invalid: number;
}

/** Snapshot for the API Management header strip. */
export async function keyPoolHealth(userId: string): Promise<KeyPoolHealth> {
  const keys = await listApiKeys(userId);
  const now = Date.now();

  return {
    total: keys.length,
    enabled: keys.filter((k) => k.enabled).length,
    usable: keys.filter(
      (k) =>
        k.enabled &&
        !['invalid', 'blocked', 'expired'].includes(k.status) &&
        (!k.cooldownUntil || Date.parse(k.cooldownUntil) <= now),
    ).length,
    coolingDown: keys.filter((k) => k.cooldownUntil && Date.parse(k.cooldownUntil) > now).length,
    invalid: keys.filter((k) => ['invalid', 'blocked', 'expired'].includes(k.status)).length,
  };
}
