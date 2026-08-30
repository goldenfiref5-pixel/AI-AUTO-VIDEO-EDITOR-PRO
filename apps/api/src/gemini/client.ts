import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { sleep } from '../utils/async';
import {
  GeminiError,
  type FailureClass,
  type GenerateContentRequest,
  type GenerateContentResponse,
  type GeminiModelInfo,
  type LongRunningOperation,
} from './types';

interface ApiErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: unknown };
}

/**
 * Map an HTTP status + Google error status onto our failure taxonomy. This is
 * what decides whether the key gets benched, the request is retried, or the
 * caller sees a hard failure.
 */
function classify(status: number, body: ApiErrorBody | null): {
  failureClass: FailureClass;
  retryable: boolean;
  keyAtFault: boolean;
} {
  const googleStatus = body?.error?.status ?? '';
  const message = body?.error?.message ?? '';

  if (status === 400) {
    // Google returns 400 INVALID_ARGUMENT both for malformed requests and for
    // "API key not valid" — the message is the only discriminator.
    if (/api key not valid|api_key_invalid|invalid api key/i.test(message)) {
      return { failureClass: 'invalid_key', retryable: false, keyAtFault: true };
    }
    return { failureClass: 'bad_request', retryable: false, keyAtFault: false };
  }
  if (status === 401) return { failureClass: 'invalid_key', retryable: false, keyAtFault: true };
  if (status === 403) {
    if (/expired|disabled|suspended/i.test(message)) {
      return { failureClass: 'invalid_key', retryable: false, keyAtFault: true };
    }
    return { failureClass: 'permission', retryable: false, keyAtFault: true };
  }
  if (status === 404) return { failureClass: 'bad_request', retryable: false, keyAtFault: false };
  if (status === 429) {
    const quota = /quota|exhausted|billing/i.test(message) || googleStatus === 'RESOURCE_EXHAUSTED';
    return {
      failureClass: quota && !/per minute|per-minute|rate/i.test(message) ? 'quota' : 'rate_limit',
      retryable: true,
      keyAtFault: true,
    };
  }
  if (status >= 500) return { failureClass: 'server', retryable: true, keyAtFault: false };
  return { failureClass: 'unknown', retryable: status >= 500, keyAtFault: false };
}

function parseRetryAfter(headers: Headers, body: ApiErrorBody | null): number | null {
  const header = headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return secs * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  // Google embeds a RetryInfo detail with a `3s`-style duration.
  const details = (body?.error?.details as Array<Record<string, unknown>> | undefined) ?? [];
  for (const detail of details) {
    const delay = detail['retryDelay'];
    if (typeof delay === 'string') {
      const match = delay.match(/^([\d.]+)s$/);
      if (match) return Math.round(Number(match[1]) * 1000);
    }
  }
  return null;
}

export interface RequestUsage {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
}

/**
 * A thin Gemini REST client bound to exactly one API key. Key rotation and
 * failover live one layer up in `keyPool.ts`.
 */
export class GeminiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = env.GEMINI_API_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = env.GEMINI_TIMEOUT_MS,
  ): Promise<{ data: T; latencyMs: number }> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'x-goog-api-key': this.apiKey,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new GeminiError({
        message: aborted
          ? `Gemini request timed out after ${timeoutMs}ms`
          : `Network failure calling Gemini: ${err instanceof Error ? err.message : String(err)}`,
        failureClass: aborted ? 'timeout' : 'network',
        retryable: true,
        keyAtFault: false,
        detail: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - started;
    const raw = await response.text();

    if (!response.ok) {
      let parsed: ApiErrorBody | null = null;
      try {
        parsed = raw ? (JSON.parse(raw) as ApiErrorBody) : null;
      } catch {
        parsed = null;
      }
      const { failureClass, retryable, keyAtFault } = classify(response.status, parsed);
      throw new GeminiError({
        message: parsed?.error?.message || `Gemini responded ${response.status}`,
        statusCode: response.status,
        failureClass,
        retryable,
        keyAtFault,
        retryAfterMs: parseRetryAfter(response.headers, parsed),
        detail: parsed ?? raw.slice(0, 500),
      });
    }

    try {
      return { data: (raw ? JSON.parse(raw) : {}) as T, latencyMs };
    } catch {
      throw new GeminiError({
        message: 'Gemini returned a non-JSON success body',
        statusCode: response.status,
        failureClass: 'unknown',
        retryable: true,
        keyAtFault: false,
        detail: raw.slice(0, 500),
      });
    }
  }

  /** Enumerate models — also the cheapest possible "is this key alive?" probe. */
  async listModels(): Promise<{ models: GeminiModelInfo[]; latencyMs: number }> {
    const { data, latencyMs } = await this.request<{ models?: GeminiModelInfo[] }>(
      'GET',
      '/v1beta/models?pageSize=200',
      undefined,
      20_000,
    );
    return { models: data.models ?? [], latencyMs };
  }

  async generateContent(
    model: string,
    request: GenerateContentRequest,
    timeoutMs?: number,
  ): Promise<{ response: GenerateContentResponse; usage: RequestUsage }> {
    const { data, latencyMs } = await this.request<GenerateContentResponse>(
      'POST',
      `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      request,
      timeoutMs,
    );

    if (data.promptFeedback?.blockReason) {
      throw new GeminiError({
        message: `Prompt blocked by safety filters (${data.promptFeedback.blockReason})`,
        failureClass: 'safety',
        retryable: false,
        keyAtFault: false,
        detail: data.promptFeedback,
      });
    }

    return {
      response: data,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        latencyMs,
        model,
      },
    };
  }

  /**
   * Upload via the resumable Files API. Required for audio and video beyond the
   * ~20 MB inline request limit; files live for 48 hours server side.
   */
  async uploadFile(params: {
    filePath: string;
    mimeType: string;
    displayName: string;
  }): Promise<FileUploadResult> {
    const info = await stat(params.filePath);
    const startUrl = `${this.baseUrl}/upload/v1beta/files`;

    const startRes = await fetch(startUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(info.size),
        'X-Goog-Upload-Header-Content-Type': params.mimeType,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: params.displayName } }),
    });

    if (!startRes.ok) {
      const text = await startRes.text();
      let parsed: ApiErrorBody | null = null;
      try {
        parsed = JSON.parse(text) as ApiErrorBody;
      } catch {
        /* keep raw */
      }
      const cls = classify(startRes.status, parsed);
      throw new GeminiError({
        message: parsed?.error?.message || `File upload init failed (${startRes.status})`,
        statusCode: startRes.status,
        ...cls,
        detail: text.slice(0, 500),
      });
    }

    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new GeminiError({
        message: 'Files API did not return an upload URL',
        failureClass: 'unknown',
        retryable: true,
        keyAtFault: false,
      });
    }

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'content-length': String(info.size),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: Readable.toWeb(createReadStream(params.filePath)) as unknown as ReadableStream,
      // Node's fetch requires duplex for a streamed request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    if (!uploadRes.ok) {
      throw new GeminiError({
        message: `File upload failed (${uploadRes.status})`,
        statusCode: uploadRes.status,
        failureClass: uploadRes.status >= 500 ? 'server' : 'bad_request',
        retryable: uploadRes.status >= 500,
        keyAtFault: false,
        detail: (await uploadRes.text()).slice(0, 500),
      });
    }

    const body = (await uploadRes.json()) as { file?: FileUploadResult };
    if (!body.file?.uri) {
      throw new GeminiError({
        message: 'Files API response did not include a file URI',
        failureClass: 'unknown',
        retryable: true,
        keyAtFault: false,
      });
    }
    return body.file;
  }

  async getFile(name: string): Promise<FileUploadResult> {
    const path = name.startsWith('files/') ? name : `files/${name}`;
    const { data } = await this.request<FileUploadResult>('GET', `/v1beta/${path}`, undefined, 20_000);
    return data;
  }

  /**
   * Uploaded media sits in `PROCESSING` briefly; generateContent rejects it
   * until it flips to `ACTIVE`.
   */
  async waitForFileActive(name: string, timeoutMs = 300_000): Promise<FileUploadResult> {
    const deadline = Date.now() + timeoutMs;
    let file = await this.getFile(name);
    while (file.state === 'PROCESSING') {
      if (Date.now() > deadline) {
        throw new GeminiError({
          message: `File ${name} was still processing after ${timeoutMs}ms`,
          failureClass: 'timeout',
          retryable: true,
          keyAtFault: false,
        });
      }
      await sleep(3000);
      file = await this.getFile(name);
    }
    if (file.state === 'FAILED') {
      throw new GeminiError({
        message: `Gemini failed to process the uploaded file: ${file.error?.message ?? 'unknown reason'}`,
        failureClass: 'bad_request',
        retryable: false,
        keyAtFault: false,
        detail: file.error,
      });
    }
    return file;
  }

  async deleteFile(name: string): Promise<void> {
    const path = name.startsWith('files/') ? name : `files/${name}`;
    await fetch(`${this.baseUrl}/v1beta/${path}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': this.apiKey },
    }).catch(() => undefined);
  }

  /** Kick off a Veo generation; returns the operation to poll. */
  async predictLongRunning(
    model: string,
    body: Record<string, unknown>,
  ): Promise<LongRunningOperation> {
    const { data } = await this.request<LongRunningOperation>(
      'POST',
      `/v1beta/models/${encodeURIComponent(model)}:predictLongRunning`,
      body,
    );
    return data;
  }

  async getOperation(name: string): Promise<LongRunningOperation> {
    const { data } = await this.request<LongRunningOperation>(
      'GET',
      `/v1beta/${name.replace(/^\//, '')}`,
      undefined,
      30_000,
    );
    return data;
  }

  /** Download bytes from a Gemini-hosted URI (Veo results, file downloads). */
  async downloadUri(uri: string): Promise<Buffer> {
    const url = uri.startsWith('http')
      ? `${uri}${uri.includes('?') ? '&' : '?'}alt=media`
      : `${this.baseUrl}/v1beta/${uri.replace(/^\//, '')}:download?alt=media`;

    const res = await fetch(url, { headers: { 'x-goog-api-key': this.apiKey } });
    if (!res.ok) {
      throw new GeminiError({
        message: `Failed to download generated media (${res.status})`,
        statusCode: res.status,
        failureClass: res.status >= 500 ? 'server' : 'bad_request',
        retryable: res.status >= 500,
        keyAtFault: false,
      });
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

export interface FileUploadResult {
  name: string;
  uri: string;
  mimeType: string;
  sizeBytes?: string;
  state?: 'PROCESSING' | 'ACTIVE' | 'FAILED';
  error?: { code: number; message: string };
  expirationTime?: string;
}

export function logGeminiError(err: unknown, context: Record<string, unknown>): void {
  if (err instanceof GeminiError) {
    logger.warn(
      { ...context, statusCode: err.statusCode, failureClass: err.failureClass, msg: err.message },
      'Gemini call failed',
    );
  } else {
    logger.warn({ ...context, err }, 'Gemini call failed');
  }
}
