import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import type { JobType } from '@aiedit/shared';
import { logger } from '../config/logger';
import { createQueueConnection } from '../lib/redis';

// BullMQ rejects ':' in a queue name — it is the separator in the Redis keys it
// builds — so namespacing goes through the `prefix` option instead.
export const QUEUE_PREFIX = 'aiedit';

export const QUEUE_NAMES = {
  analysis: 'analysis',
  generation: 'generation',
  render: 'render',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface JobPayload {
  /** Our own jobs row id — the queue job is only a scheduling handle. */
  jobId: string;
  projectId: string;
  userId: string;
  type: JobType;
  [key: string]: unknown;
}

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 15_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const connections = new Map<string, ReturnType<typeof createQueueConnection>>();
const queues = new Map<QueueName, Queue<JobPayload>>();

function connectionFor(name: string) {
  let connection = connections.get(name);
  if (!connection) {
    connection = createQueueConnection(name);
    connections.set(name, connection);
  }
  return connection;
}

export function getQueue(name: QueueName): Queue<JobPayload> {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue<JobPayload>(name, {
      connection: connectionFor(`queue-${name}`),
      prefix: QUEUE_PREFIX,
      defaultJobOptions,
    });
    queues.set(name, queue);
  }
  return queue;
}

/** Which queue handles which pipeline stage. */
export function queueForJobType(type: JobType): QueueName {
  switch (type) {
    case 'transcribe':
    case 'analyze_references':
    case 'story_analysis':
      return QUEUE_NAMES.analysis;
    case 'generate_images':
    case 'generate_clips':
      return QUEUE_NAMES.generation;
    case 'render':
      return QUEUE_NAMES.render;
  }
}

export interface EnqueueOptions {
  /** Lower numbers run first, matching BullMQ's priority semantics. */
  priority?: number;
  delayMs?: number;
  attempts?: number;
}

export async function enqueue(
  payload: JobPayload,
  options: EnqueueOptions = {},
): Promise<string> {
  const queue = getQueue(queueForJobType(payload.type));

  // BullMQ rejects ':' in a custom id, and silently ignores an `add` whose id
  // already exists — which would make every retry a no-op. A per-attempt
  // suffix keeps the id unique; the real handle is stored on the job row.
  const queueJobId = `${payload.jobId}-${Date.now().toString(36)}`;

  const job = await queue.add(payload.type, payload, {
    priority: options.priority ?? 10,
    delay: options.delayMs,
    attempts: options.attempts,
    jobId: queueJobId,
  });

  logger.info({ jobId: payload.jobId, type: payload.type, queueJobId: job.id }, 'Job enqueued');
  return job.id ?? queueJobId;
}

/** Remove a queued entry by the id stored on the job row. */
export async function removeQueueJob(type: JobType, queueJobId: string | null): Promise<void> {
  if (!queueJobId) return;
  const queue = getQueue(queueForJobType(type));
  const job = await queue.getJob(queueJobId);
  await job?.remove().catch(() => undefined);
}

export async function pauseQueue(name: QueueName): Promise<void> {
  await getQueue(name).pause();
}

export async function resumeQueue(name: QueueName): Promise<void> {
  await getQueue(name).resume();
}

export interface QueueDepth {
  name: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: boolean;
}

export async function queueDepths(): Promise<QueueDepth[]> {
  return Promise.all(
    Object.values(QUEUE_NAMES).map(async (name) => {
      const queue = getQueue(name);
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      return {
        name,
        waiting: counts['waiting'] ?? 0,
        active: counts['active'] ?? 0,
        delayed: counts['delayed'] ?? 0,
        failed: counts['failed'] ?? 0,
        completed: counts['completed'] ?? 0,
        paused: await queue.isPaused(),
      };
    }),
  );
}

export function createQueueEvents(name: QueueName): QueueEvents {
  return new QueueEvents(name, {
    connection: connectionFor(`events-${name}`),
    prefix: QUEUE_PREFIX,
  });
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close().catch(() => undefined)));
  await Promise.all([...connections.values()].map((c) => c.quit().catch(() => undefined)));
  queues.clear();
  connections.clear();
}
