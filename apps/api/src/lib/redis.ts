import IORedis, { type Redis } from 'ioredis';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connections it blocks on,
 * so queue clients get their own instances rather than sharing the app client.
 */
function create(name: string, options: Record<string, unknown> = {}): Redis {
  const client = new IORedis(env.REDIS_URL, {
    lazyConnect: false,
    enableReadyCheck: true,
    connectionName: `aiedit:${name}`,
    ...options,
  });
  client.on('error', (err) => logger.error({ err, name }, 'Redis connection error'));
  return client;
}

/** General-purpose client for caching, locks and pub/sub publishing. */
export const redis = create('app');

export function createQueueConnection(name: string): Redis {
  return create(name, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

export async function closeRedis(): Promise<void> {
  await redis.quit().catch(() => undefined);
}

/**
 * Best-effort distributed lock. Returns a release function, or null when the
 * lock is already held.
 */
export async function acquireLock(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
  const token = Math.random().toString(36).slice(2);
  const ok = await redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
  if (!ok) return null;

  return async () => {
    // Only release the lock if we still own it.
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end`;
    await redis.eval(script, 1, `lock:${key}`, token).catch(() => undefined);
  };
}

export const PROGRESS_CHANNEL = 'aiedit:progress';
