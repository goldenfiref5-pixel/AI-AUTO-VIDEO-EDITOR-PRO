'use client';

/**
 * Browser API client.
 *
 * The access token lives in memory with a localStorage mirror so a reload does
 * not sign the user out, and a 401 triggers exactly one refresh attempt before
 * the request is replayed.
 */

const BASE_URL = (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000').replace(/\/$/, '');

const ACCESS_KEY = 'aiedit.access';
const REFRESH_KEY = 'aiedit.refresh';

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

export function loadStoredTokens(): void {
  if (typeof window === 'undefined') return;
  accessToken = window.localStorage.getItem(ACCESS_KEY);
}

export function setTokens(access: string, refresh?: string): void {
  accessToken = access;
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACCESS_KEY, access);
  if (refresh) window.localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens(): void {
  accessToken = null;
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
}

export function currentToken(): string | null {
  if (accessToken) return accessToken;
  if (typeof window !== 'undefined') accessToken = window.localStorage.getItem(ACCESS_KEY);
  return accessToken;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

async function refreshSession(): Promise<boolean> {
  // Collapse concurrent 401s into a single refresh round trip.
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(REFRESH_KEY) : null;
    try {
      const response = await fetch(`${BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(stored ? { refreshToken: stored } : {}),
      });
      if (!response.ok) return false;

      const body = (await response.json()) as { accessToken: string; refreshToken?: string };
      setTokens(body.accessToken, body.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the automatic refresh-and-replay (used by the auth calls themselves). */
  skipAuthRetry?: boolean;
  query?: Record<string, string | number | boolean | undefined>;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipAuthRetry, query, headers, ...rest } = options;

  const url = new URL(`${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const token = currentToken();

  const send = () =>
    fetch(url.toString(), {
      ...rest,
      credentials: 'include',
      headers: {
        ...(isFormData ? {} : body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(currentToken() ? { authorization: `Bearer ${currentToken()}` } : {}),
        ...(headers as Record<string, string> | undefined),
      },
      body: isFormData ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
    });

  let response = await send();

  if (response.status === 401 && !skipAuthRetry && token) {
    if (await refreshSession()) {
      response = await send();
    } else {
      clearTokens();
    }
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const error = (parsed as ErrorBody)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'error',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'DELETE' }),
};

/**
 * Upload with progress. `fetch` cannot report upload progress, so voiceover and
 * reference uploads go through XHR — a two-hour WAV needs a real progress bar.
 */
export function uploadWithProgress<T>(
  path: string,
  formData: FormData,
  onProgress?: (fraction: number) => void,
): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', `${BASE_URL}${path}`);
    xhr.withCredentials = true;

    const token = currentToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });

    xhr.addEventListener('load', () => {
      let parsed: unknown = null;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        parsed = xhr.responseText;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed as T);
        return;
      }
      const error = (parsed as ErrorBody)?.error;
      reject(
        new ApiError(
          xhr.status,
          error?.code ?? 'error',
          error?.message ?? `Upload failed with status ${xhr.status}`,
          error?.details,
        ),
      );
    });

    xhr.addEventListener('error', () => reject(new ApiError(0, 'network', 'Network error during upload')));
    xhr.addEventListener('abort', () => reject(new ApiError(0, 'aborted', 'Upload cancelled')));

    xhr.send(formData);
  });

  return { promise, abort: () => xhr.abort() };
}

/**
 * Subscribe to a project's progress stream.
 *
 * EventSource cannot send an Authorization header, so the token travels as a
 * query parameter on this one endpoint.
 */
export function progressStreamUrl(projectId: string): string {
  const url = new URL(`${BASE_URL}/api/projects/${projectId}/progress`);
  const token = currentToken();
  if (token) url.searchParams.set('access_token', token);
  return url.toString();
}

export { BASE_URL };
