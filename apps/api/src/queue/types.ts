import type { JobType } from '@aiedit/shared';

/**
 * Queue names and payload shapes, shared by both drivers.
 *
 * The platform can run its queues on Redis (via BullMQ) or on PostgreSQL. The
 * Redis driver is what the Docker stack uses; the PostgreSQL driver exists so
 * the whole platform can run natively on Windows, where Redis has no maintained
 * build.
 */
export const QUEUE_PREFIX = 'aiedit';

export const QUEUE_NAMES = {
  analysis: 'analysis',
  generation: 'generation',
  render: 'render',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE_NAMES);

export interface JobPayload {
  /** Our own jobs row id — the queue entry is only a scheduling handle. */
  jobId: string;
  projectId: string;
  userId: string;
  type: JobType;
  [key: string]: unknown;
}

export interface EnqueueOptions {
  /** Lower numbers run first. */
  priority?: number;
  delayMs?: number;
  attempts?: number;
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

/** What a handler receives, normalised across drivers. */
export interface JobContext {
  payload: JobPayload;
  /** Attempts already made, 0 on the first run — matching BullMQ. */
  attemptsMade: number;
  maxAttempts: number;
  /** Put the job back with a delay, for waiting on an upstream stage. */
  defer(delayMs: number): Promise<void>;
}

export type JobHandler = (context: JobContext) => Promise<void>;

export interface WorkerHandle {
  close(): Promise<void>;
}

export interface QueueDriver {
  readonly name: 'redis' | 'postgres';
  enqueue(payload: JobPayload, options: EnqueueOptions): Promise<string>;
  remove(type: JobType, queueJobId: string | null): Promise<void>;
  pause(queue: QueueName): Promise<void>;
  resume(queue: QueueName): Promise<void>;
  depths(): Promise<QueueDepth[]>;
  startWorker(queue: QueueName, concurrency: number, handler: JobHandler): Promise<WorkerHandle>;
  close(): Promise<void>;
}

/** Which queue serves which pipeline stage. */
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

export const DEFAULT_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 15_000;

/** Exponential backoff shared by both drivers. */
export function backoffMs(attemptsMade: number): number {
  return Math.min(10 * 60_000, BASE_BACKOFF_MS * 2 ** attemptsMade);
}
