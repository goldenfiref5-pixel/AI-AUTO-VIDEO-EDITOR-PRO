import type { Job, JobStatus, JobType } from '@aiedit/shared';
import { query, queryOne } from '../db/pool';
import { redis } from '../lib/redis';
import { badRequest, notFound } from '../utils/errors';
import { mapJob } from './mappers';
import { publishProgress } from './progress';

const COLUMNS = `id, project_id, user_id, type, status, progress, total, completed, failed,
                 priority, attempts, message, error_message, payload, queue_job_id,
                 cancel_requested, started_at, finished_at, created_at, updated_at`;

export interface CreateJobData {
  projectId: string;
  userId: string;
  type: JobType;
  priority?: number;
  payload?: Record<string, unknown>;
  total?: number;
}

export async function createJob(data: CreateJobData): Promise<Job> {
  const row = await queryOne(
    `INSERT INTO jobs (project_id, user_id, type, priority, payload, total)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     RETURNING ${COLUMNS}`,
    [
      data.projectId,
      data.userId,
      data.type,
      data.priority ?? 10,
      JSON.stringify(data.payload ?? {}),
      data.total ?? 0,
    ],
  );
  return mapJob(row!);
}

export async function getJob(id: string): Promise<Job | null> {
  const row = await queryOne(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id]);
  return row ? mapJob(row) : null;
}

export async function requireJob(id: string, userId: string, isAdmin = false): Promise<Job> {
  const job = await getJob(id);
  if (!job) throw notFound('Job not found');
  if (!isAdmin && job.userId !== userId) throw notFound('Job not found');
  return job;
}

export async function listProjectJobs(projectId: string): Promise<Job[]> {
  const rows = await query(
    `SELECT ${COLUMNS} FROM jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [projectId],
  );
  return rows.map(mapJob);
}

export interface ListJobsParams {
  userId: string;
  status?: JobStatus;
  page: number;
  pageSize: number;
}

export async function listUserJobs(params: ListJobsParams): Promise<{ items: Job[]; total: number }> {
  const values: unknown[] = [params.userId];
  let where = 'user_id = $1';
  if (params.status) {
    values.push(params.status);
    where += ` AND status = $${values.length}`;
  }

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM jobs WHERE ${where}`,
    values,
  );

  values.push(params.pageSize, (params.page - 1) * params.pageSize);
  const rows = await query(
    `SELECT ${COLUMNS} FROM jobs WHERE ${where}
      ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: rows.map(mapJob), total: Number(countRow?.count ?? 0) };
}

export async function attachQueueJob(jobId: string, queueJobId: string): Promise<void> {
  await query('UPDATE jobs SET queue_job_id = $2 WHERE id = $1', [jobId, queueJobId]);
}

export async function markJobStarted(jobId: string): Promise<void> {
  await query(
    `UPDATE jobs SET status = 'processing', started_at = COALESCE(started_at, now()),
            attempts = attempts + 1, error_message = NULL
      WHERE id = $1`,
    [jobId],
  );
}

export interface JobProgressUpdate {
  status?: JobStatus;
  progress?: number;
  message?: string;
  total?: number;
  completed?: number;
  failed?: number;
}

export async function updateJobProgress(job: Job, update: JobProgressUpdate): Promise<void> {
  // The caller usually holds a snapshot taken before the job started, so the
  // authoritative status and progress come back from the UPDATE rather than
  // from that stale object.
  const row = await queryOne<{ status: JobStatus; progress: string; message: string | null }>(
    `UPDATE jobs SET
       status = COALESCE($2, status),
       progress = COALESCE($3, progress),
       message = COALESCE($4, message),
       total = COALESCE($5, total),
       completed = COALESCE($6, completed),
       failed = COALESCE($7, failed)
     WHERE id = $1
     RETURNING status, progress::text, message`,
    [
      job.id,
      update.status ?? null,
      update.progress === undefined ? null : Math.max(0, Math.min(100, update.progress)),
      update.message ?? null,
      update.total ?? null,
      update.completed ?? null,
      update.failed ?? null,
    ],
  );

  await publishProgress({
    projectId: job.projectId,
    jobId: job.id,
    type: job.type,
    status: row?.status ?? update.status ?? job.status,
    progress: row ? Number(row.progress) : (update.progress ?? job.progress),
    message: row?.message ?? update.message ?? '',
  });
}

export async function markJobFinished(
  job: Job,
  status: Extract<JobStatus, 'completed' | 'failed' | 'cancelled'>,
  errorMessage?: string,
): Promise<void> {
  await query(
    `UPDATE jobs SET status = $2, finished_at = now(), progress = $3, error_message = $4
      WHERE id = $1`,
    [job.id, status, status === 'completed' ? 100 : job.progress, errorMessage ?? null],
  );

  await publishProgress({
    projectId: job.projectId,
    jobId: job.id,
    type: job.type,
    status,
    progress: status === 'completed' ? 100 : job.progress,
    message: errorMessage ?? (status === 'completed' ? 'Completed' : status),
  });
}

/**
 * Cancellation is cooperative: the flag is set here and long-running stages
 * poll it, because a BullMQ job that is already executing cannot be killed.
 */
export async function requestCancel(jobId: string): Promise<void> {
  await query(
    `UPDATE jobs SET cancel_requested = true,
            status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
            finished_at = CASE WHEN status = 'pending' THEN now() ELSE finished_at END
      WHERE id = $1`,
    [jobId],
  );
  await redis.set(`job:cancel:${jobId}`, '1', 'EX', 86_400).catch(() => undefined);
}

export async function isCancelRequested(jobId: string): Promise<boolean> {
  const cached = await redis.get(`job:cancel:${jobId}`).catch(() => null);
  if (cached === '1') return true;
  const row = await queryOne<{ cancel_requested: boolean }>(
    'SELECT cancel_requested FROM jobs WHERE id = $1',
    [jobId],
  );
  return Boolean(row?.cancel_requested);
}

export async function clearCancel(jobId: string): Promise<void> {
  await query('UPDATE jobs SET cancel_requested = false WHERE id = $1', [jobId]);
  await redis.del(`job:cancel:${jobId}`).catch(() => undefined);
}

export async function assertNotCancelled(jobId: string): Promise<void> {
  if (await isCancelRequested(jobId)) {
    const error = new Error('Job cancelled by the user');
    error.name = 'JobCancelled';
    throw error;
  }
}

/**
 * Jobs that will never make progress on their own. Called at worker boot so a
 * restart recovers rather than stranding the project.
 *
 * Two cases: a job left mid-flight by a crashed worker, and a job whose row was
 * written but whose enqueue never landed (a Redis blip between the two writes),
 * which is recognisable by a missing `queue_job_id`.
 */
export async function reclaimStaleJobs(olderThanMinutes = 30): Promise<Job[]> {
  const rows = await query(
    `UPDATE jobs SET status = 'pending', message = 'Recovered after a worker restart'
      WHERE (
              (status IN ('processing','generating_images','generating_video','rendering')
                AND updated_at < now() - ($1 || ' minutes')::interval)
              OR
              (status = 'pending' AND queue_job_id IS NULL
                AND created_at < now() - INTERVAL '2 minutes')
            )
      RETURNING ${COLUMNS}`,
    [olderThanMinutes],
  );
  return rows.map(mapJob);
}

export async function retryableJob(job: Job): Promise<void> {
  if (!['failed', 'cancelled'].includes(job.status)) {
    throw badRequest(`Only failed or cancelled jobs can be retried (this one is ${job.status}).`);
  }
}

export async function resetJobForRetry(jobId: string): Promise<Job> {
  const row = await queryOne(
    `UPDATE jobs SET status = 'pending', progress = 0, error_message = NULL,
            cancel_requested = false, finished_at = NULL, message = 'Queued for retry'
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [jobId],
  );
  if (!row) throw notFound('Job not found');
  await redis.del(`job:cancel:${jobId}`).catch(() => undefined);
  return mapJob(row);
}
