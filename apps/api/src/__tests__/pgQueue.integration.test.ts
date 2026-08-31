import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Exercises the PostgreSQL queue driver against a real database.
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable database, because it
 * truncates the queue tables. Run it with, for example:
 *
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5432/aiedit_test npm test
 */
const TEST_DB = process.env['TEST_DATABASE_URL'];
const describeDb = TEST_DB ? describe : describe.skip;

if (TEST_DB) {
  // config/env reads this at import time, so it must be set before the driver
  // and pool modules are pulled in below.
  process.env['DATABASE_URL'] = TEST_DB;
  process.env['JWT_SECRET'] ||= 'test-secret-value-for-integration-tests';
  process.env['ENCRYPTION_KEY'] ||= 'a'.repeat(64);
  process.env['LOG_LEVEL'] ||= 'fatal';
}

describeDb('PostgresQueueDriver', () => {
  let driver: import('../queue/pgDriver').PostgresQueueDriver;
  let query: typeof import('../db/pool').query;
  let closePool: typeof import('../db/pool').closePool;
  let QUEUE_NAMES: typeof import('../queue/types').QUEUE_NAMES;

  beforeAll(async () => {
    const pool = await import('../db/pool');
    const pg = await import('../queue/pgDriver');
    const types = await import('../queue/types');

    query = pool.query;
    closePool = pool.closePool;
    QUEUE_NAMES = types.QUEUE_NAMES;
    driver = new pg.PostgresQueueDriver();

    await (await import('../db/migrate')).runMigrations();
    await query('DELETE FROM queue_jobs');
    await query('DELETE FROM queue_state');
  }, 120_000);

  afterAll(async () => {
    await driver?.close();
    await closePool?.();
  });

  it('hands every job to exactly one worker, and retries a failure', async () => {
    const TOTAL = 40;

    for (let i = 0; i < TOTAL; i += 1) {
      await driver.enqueue(
        { jobId: `job-${i}`, projectId: 'p', userId: 'u', type: 'transcribe' },
        { priority: i % 5 },
      );
    }

    const seen = new Map<string, number>();

    const handler = async (ctx: { payload: { jobId: string }; attemptsMade: number }) => {
      const id = ctx.payload.jobId;
      seen.set(id, (seen.get(id) ?? 0) + 1);
      // One job fails on its first attempt, to prove the retry path.
      if (id === 'job-7' && ctx.attemptsMade === 0) throw new Error('injected failure');
      await new Promise((r) => setTimeout(r, 5));
    };

    // Several workers on one queue: SKIP LOCKED must stop a job being claimed twice.
    const workers = await Promise.all(
      [1, 2, 3, 4].map(() => driver.startWorker(QUEUE_NAMES.analysis, 3, handler as never)),
    );

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const rows = await query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM queue_jobs WHERE status IN ('waiting','active')",
      );
      if (Number(rows[0]!.count) === 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    await Promise.all(workers.map((w) => w.close()));

    expect(seen.size).toBe(TOTAL);
    // Exactly one job ran twice: the one told to fail first time round.
    expect([...seen.values()].filter((n) => n > 1)).toHaveLength(1);
    expect(seen.get('job-7')).toBe(2);

    const remaining = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM queue_jobs WHERE status IN ('waiting','active')",
    );
    expect(Number(remaining[0]!.count)).toBe(0);
  }, 120_000);

  it('does not dispatch while the queue is paused', async () => {
    await query('DELETE FROM queue_jobs');
    await driver.pause(QUEUE_NAMES.render);

    await driver.enqueue(
      { jobId: 'paused-1', projectId: 'p', userId: 'u', type: 'render' },
      {},
    );

    let ran = 0;
    const worker = await driver.startWorker(QUEUE_NAMES.render, 1, (async () => {
      ran += 1;
    }) as never);

    await new Promise((r) => setTimeout(r, 3000));
    expect(ran).toBe(0);

    await driver.resume(QUEUE_NAMES.render);
    await new Promise((r) => setTimeout(r, 4000));
    await worker.close();

    expect(ran).toBe(1);
  }, 60_000);
});
