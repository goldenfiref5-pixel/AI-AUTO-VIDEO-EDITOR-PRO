export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Return false to stop retrying and rethrow immediately. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/** Exponential backoff with full jitter. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs = 30_000, shouldRetry, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      if (shouldRetry && !shouldRetry(err, attempt)) break;

      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(Math.random() * ceiling);
      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Run `worker` over `items` with bounded concurrency, preserving input order in
 * the result. Rejections propagate once the in-flight batch settles.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;

  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Reject with a clear message instead of hanging on an unresponsive upstream. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Simple counting semaphore used to cap per-key concurrency. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}
