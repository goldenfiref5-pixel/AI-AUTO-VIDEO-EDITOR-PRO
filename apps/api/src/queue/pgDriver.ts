import crypto from 'node:crypto';
import type { JobType } from '@aiedit/shared';
import { logger } from '../config/logger';
import { query, queryOne } from '../db/pool';
import { sleep } from '../utils/async';
import {
  ALL_QUEUES,
  DEFAULT_ATTEMPTS,
  backoffMs,
  queueForJobType,
  type EnqueueOptions,
  type JobContext,
  type JobHandler,
  type JobPayload,
  type QueueDepth,
  type QueueDriver,
  type QueueName,
  type WorkerHandle,
} from './types';

/**
 * A job queue built on PostgreSQL.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, which lets many workers pull from the
 * same queue without blocking each other and without a separate broker. That is
 * the whole point: it removes Redis, and with it the only dependency that has
 * no maintained Windows build.
 *
 * Polling interval is a deliberate trade-off. Redis blocks on a list pop and
 * wakes instantly; here a short poll costs one cheap indexed query per worker
 * per interval, which is immaterial next to the minutes each pipeline stage
 * takes.
 */
const POLL_INTERVAL_MS = 1000;
const IDLE_POLL_INTERVAL_MS = 2500;

/** A job whose lock is older than this is assumed to belong to a dead worker. */
const STALL_TIMEOUT_MS = 15 * 60_000;

interface QueueJobRow {
  id: string;
  queue: string;
  name: string;
  payload: JobPayload;
  priority: number;
  attempts: number;
  max_attempts: number;
  status: string;
}

const WORKER_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

export class PostgresQueueDriver implements QueueDriver {
  readonly name = 'postgres' as const;
  private readonly workers = new Set<PostgresWorker>();

  async enqueue(payload: JobPayload, options: EnqueueOptions): Promise<string> {
    const queue = queueForJobType(payload.type);
    const row = await queryOne<{ id: string }>(
      `INSERT INTO queue_jobs (queue, name, payload, priority, max_attempts, run_after)
       VALUES ($1, $2, $3::jsonb, $4, $5, now() + ($6::int || ' milliseconds')::interval)
       RETURNING id`,
      [
        queue,
        payload.type,
        JSON.stringify(payload),
        options.priority ?? 10,
        options.attempts ?? DEFAULT_ATTEMPTS,
        options.delayMs ?? 0,
      ],
    );

    logger.info({ jobId: payload.jobId, type: payload.type, queueJobId: row!.id }, 'Job enqueued');
    return row!.id;
  }

  async remove(_type: JobType, queueJobId: string | null): Promise<void> {
    if (!queueJobId) return;
    // Only an unstarted entry can be removed; a running one is stopped through
    // the cooperative cancel flag on the jobs row.
    await query(`DELETE FROM queue_jobs WHERE id = $1 AND status = 'waiting'`, [queueJobId]);
  }

  async pause(queue: QueueName): Promise<void> {
    await query(
      `INSERT INTO queue_state (queue, paused) VALUES ($1, true)
       ON CONFLICT (queue) DO UPDATE SET paused = true, updated_at = now()`,
      [queue],
    );
  }

  async resume(queue: QueueName): Promise<void> {
    await query(
      `INSERT INTO queue_state (queue, paused) VALUES ($1, false)
       ON CONFLICT (queue) DO UPDATE SET paused = false, updated_at = now()`,
      [queue],
    );
  }

  async depths(): Promise<QueueDepth[]> {
    const counts = await query<{ queue: string; status: string; delayed: string; count: string }>(
      `SELECT queue,
              status,
              COUNT(*) FILTER (WHERE run_after > now())::text AS delayed,
              COUNT(*)::text AS count
         FROM queue_jobs
        GROUP BY queue, status`,
    );
    const paused = await query<{ queue: string; paused: boolean }>(
      'SELECT queue, paused FROM queue_state',
    );
    const pausedSet = new Set(paused.filter((p) => p.paused).map((p) => p.queue));

    return ALL_QUEUES.map((name) => {
      const rows = counts.filter((c) => c.queue === name);
      const of = (status: string) => Number(rows.find((r) => r.status === status)?.count ?? 0);
      const delayed = rows
        .filter((r) => r.status === 'waiting')
        .reduce((sum, r) => sum + Number(r.delayed), 0);

      return {
        name,
        waiting: Math.max(0, of('waiting') - delayed),
        active: of('active'),
        delayed,
        failed: of('failed'),
        completed: of('completed'),
        paused: pausedSet.has(name),
      };
    });
  }

  async startWorker(
    queue: QueueName,
    concurrency: number,
    handler: JobHandler,
  ): Promise<WorkerHandle> {
    const worker = new PostgresWorker(queue, concurrency, handler);
    this.workers.add(worker);
    worker.start();

    return {
      close: async () => {
        await worker.stop();
        this.workers.delete(worker);
      },
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.workers].map((w) => w.stop()));
    this.workers.clear();
  }
}

class PostgresWorker {
  private running = false;
  private readonly active = new Set<Promise<void>>();

  constructor(
    private readonly queue: QueueName,
    private readonly concurrency: number,
    private readonly handler: JobHandler,
  ) {}

  start(): void {
    this.running = true;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    // Let in-flight work finish rather than abandoning a half-written render.
    await Promise.allSettled([...this.active]);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (this.active.size >= this.concurrency) {
          await Promise.race([...this.active]);
          continue;
        }

        if (await this.isPaused()) {
          await sleep(IDLE_POLL_INTERVAL_MS);
          continue;
        }

        await this.reclaimStalled();

        const row = await this.claim();
        if (!row) {
          await sleep(IDLE_POLL_INTERVAL_MS);
          continue;
        }

        const task = this.run(row).finally(() => this.active.delete(task));
        this.active.add(task);
      } catch (err) {
        logger.error({ err, queue: this.queue }, 'Queue loop error');
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  private async isPaused(): Promise<boolean> {
    const row = await queryOne<{ paused: boolean }>(
      'SELECT paused FROM queue_state WHERE queue = $1',
      [this.queue],
    );
    return Boolean(row?.paused);
  }

  /**
   * Claim one job atomically. SKIP LOCKED means concurrent workers step over
   * each other's candidate rows instead of serialising on them.
   */
  private async claim(): Promise<QueueJobRow | null> {
    return queryOne<QueueJobRow>(
      `UPDATE queue_jobs SET
         status = 'active',
         locked_by = $2,
         locked_at = now(),
         attempts = attempts + 1
       WHERE id = (
         SELECT id FROM queue_jobs
          WHERE queue = $1
            AND status = 'waiting'
            AND run_after <= now()
          ORDER BY priority ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING id, queue, name, payload, priority, attempts, max_attempts, status`,
      [this.queue, WORKER_ID],
    );
  }

  /** Return jobs abandoned by a killed worker to the waiting pool. */
  private async reclaimStalled(): Promise<void> {
    const rows = await query<{ id: string }>(
      `UPDATE queue_jobs SET status = 'waiting', locked_by = NULL, locked_at = NULL
        WHERE queue = $1
          AND status = 'active'
          AND locked_at < now() - ($2::int || ' milliseconds')::interval
        RETURNING id`,
      [this.queue, STALL_TIMEOUT_MS],
    );
    if (rows.length > 0) {
      logger.warn({ queue: this.queue, count: rows.length }, 'Reclaimed stalled queue entries');
    }
  }

  private async run(row: QueueJobRow): Promise<void> {
    let deferred = false;

    const context: JobContext = {
      payload: row.payload,
      // `attempts` was incremented on claim, so subtract to match BullMQ's
      // 0-based attemptsMade.
      attemptsMade: Math.max(0, row.attempts - 1),
      maxAttempts: row.max_attempts,
      defer: async (delayMs: number) => {
        deferred = true;
        await query(
          `UPDATE queue_jobs SET
             status = 'waiting',
             locked_by = NULL,
             locked_at = NULL,
             -- A deferral is a wait, not a failed attempt.
             attempts = GREATEST(0, attempts - 1),
             run_after = now() + ($2::int || ' milliseconds')::interval
           WHERE id = $1`,
          [row.id, delayMs],
        );
      },
    };

    try {
      await this.handler(context);
      if (deferred) return;
      await query(`DELETE FROM queue_jobs WHERE id = $1`, [row.id]);
    } catch (err) {
      if (deferred) return;

      const message = err instanceof Error ? err.message : String(err);
      const canRetry = row.attempts < row.max_attempts;

      if (canRetry) {
        await query(
          `UPDATE queue_jobs SET
             status = 'waiting',
             locked_by = NULL,
             locked_at = NULL,
             last_error = $2,
             run_after = now() + ($3::int || ' milliseconds')::interval
           WHERE id = $1`,
          [row.id, message.slice(0, 2000), backoffMs(row.attempts)],
        );
      } else {
        await query(
          `UPDATE queue_jobs SET status = 'failed', locked_by = NULL, last_error = $2
            WHERE id = $1`,
          [row.id, message.slice(0, 2000)],
        );
      }

      logger.error(
        { err, queue: this.queue, jobId: row.payload.jobId, attempt: row.attempts, willRetry: canRetry },
        'Queue job failed',
      );
    }
  }
}
