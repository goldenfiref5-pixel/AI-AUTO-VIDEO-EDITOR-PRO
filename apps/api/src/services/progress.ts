import type { ProgressEvent } from '@aiedit/shared';
import { logger } from '../config/logger';
import { PROGRESS_CHANNEL, createQueueConnection, redis } from '../lib/redis';

type Listener = (event: ProgressEvent) => void;

/**
 * Fan-out of pipeline progress.
 *
 * Workers and the API run as separate processes, so events travel over Redis
 * pub/sub and each API instance re-broadcasts to its own SSE subscribers.
 */
const listeners = new Map<string, Set<Listener>>();
let subscriber: ReturnType<typeof createQueueConnection> | null = null;

export function subscribeToProject(projectId: string, listener: Listener): () => void {
  ensureSubscriber();
  let set = listeners.get(projectId);
  if (!set) {
    set = new Set();
    listeners.set(projectId, set);
  }
  set.add(listener);

  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(projectId);
  };
}

function ensureSubscriber(): void {
  if (subscriber) return;
  subscriber = createQueueConnection('progress-sub');
  subscriber.subscribe(PROGRESS_CHANNEL).catch((err) => {
    logger.error({ err }, 'Failed to subscribe to the progress channel');
  });
  subscriber.on('message', (_channel: string, payload: string) => {
    try {
      const event = JSON.parse(payload) as ProgressEvent;
      for (const listener of listeners.get(event.projectId) ?? []) listener(event);
    } catch (err) {
      logger.warn({ err }, 'Malformed progress event');
    }
  });
}

export async function publishProgress(event: Omit<ProgressEvent, 'at'>): Promise<void> {
  const payload: ProgressEvent = { ...event, at: new Date().toISOString() };
  // Keep the last event per project so a client connecting mid-render gets an
  // immediate snapshot instead of waiting for the next tick.
  await redis
    .multi()
    .set(`progress:${event.projectId}`, JSON.stringify(payload), 'EX', 86_400)
    .publish(PROGRESS_CHANNEL, JSON.stringify(payload))
    .exec()
    .catch((err) => logger.warn({ err }, 'Failed to publish progress'));
}

export async function lastProgress(projectId: string): Promise<ProgressEvent | null> {
  const raw = await redis.get(`progress:${projectId}`).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProgressEvent;
  } catch {
    return null;
  }
}

export async function closeProgress(): Promise<void> {
  await subscriber?.quit().catch(() => undefined);
  subscriber = null;
  listeners.clear();
}
