-- PostgreSQL-backed job queue.
--
-- Used when QUEUE_DRIVER=postgres, which lets the platform run natively on
-- Windows: Redis has no maintained Windows build, but PostgreSQL does, and it
-- can serve the queue, the progress fan-out and the locks on its own.

CREATE TABLE queue_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue        TEXT NOT NULL,
  name         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority     INTEGER NOT NULL DEFAULT 10,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  -- waiting | active | completed | failed
  status       TEXT NOT NULL DEFAULT 'waiting',
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by    TEXT,
  locked_at    TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The claim query orders by priority then age within one queue, so this index
-- is what keeps `FOR UPDATE SKIP LOCKED` from scanning the whole table.
CREATE INDEX queue_jobs_claim_idx
  ON queue_jobs (queue, status, run_after, priority, created_at);

-- Finding a queued entry by the id stored on the jobs row, for cancellation.
CREATE INDEX queue_jobs_job_idx ON queue_jobs ((payload ->> 'jobId'));

-- Sweeping stalled entries left behind by a killed worker.
CREATE INDEX queue_jobs_stalled_idx ON queue_jobs (status, locked_at);

CREATE TABLE queue_state (
  queue      TEXT PRIMARY KEY,
  paused     BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER queue_jobs_touch
  BEFORE UPDATE ON queue_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
