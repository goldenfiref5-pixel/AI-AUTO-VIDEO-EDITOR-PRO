import { Worker, type Job as BullJob } from 'bullmq';
import { env } from './config/env';
import { logger } from './config/logger';
import { closePool } from './db/pool';
import { closeRedis, createQueueConnection } from './lib/redis';
import {
  runAnalyzeReferences,
  runGenerateClips,
  runGenerateImages,
  runRender,
  runStoryAnalysis,
  runTranscribe,
} from './pipeline/stages';
import {
  clearCancel,
  getJob,
  isCancelRequested,
  markJobFinished,
  markJobStarted,
  reclaimStaleJobs,
} from './services/jobs';
import { setProjectStatus } from './services/projects';
import { QUEUE_NAMES, QUEUE_PREFIX, type JobPayload, type QueueName } from './queue/queues';
import { errorMessage } from './utils/errors';
import { ffmpegAvailable } from './render/ffmpeg';
import { requeueJob } from './services/pipeline';

const HANDLERS = {
  transcribe: runTranscribe,
  analyze_references: runAnalyzeReferences,
  story_analysis: runStoryAnalysis,
  generate_images: runGenerateImages,
  generate_clips: runGenerateClips,
  render: runRender,
} as const;

async function processJob(bullJob: BullJob<JobPayload>): Promise<void> {
  const { jobId, type } = bullJob.data;
  const job = await getJob(jobId);

  if (!job) {
    logger.warn({ jobId }, 'Queue job references a job row that no longer exists');
    return;
  }

  if (await isCancelRequested(jobId)) {
    await markJobFinished(job, 'cancelled', 'Cancelled before it started');
    await clearCancel(jobId);
    return;
  }

  // A stage that depends on another waits for it rather than racing ahead. The
  // dependency is expressed in the payload so a retry re-checks it.
  const dependsOn = bullJob.data['dependsOn'];
  if (typeof dependsOn === 'string') {
    const upstream = await getJob(dependsOn);
    if (upstream && !['completed', 'failed', 'cancelled'].includes(upstream.status)) {
      logger.debug({ jobId, dependsOn }, 'Upstream job still running; deferring');
      await bullJob.moveToDelayed(Date.now() + 15_000, bullJob.token);
      return;
    }
    if (upstream?.status === 'failed') {
      await markJobFinished(job, 'cancelled', 'Skipped because the previous stage failed');
      return;
    }
    if (upstream?.status === 'cancelled') {
      await markJobFinished(job, 'cancelled', 'Skipped because the previous stage was cancelled');
      return;
    }
  }

  const handler = HANDLERS[type];
  if (!handler) throw new Error(`No handler registered for job type "${type}"`);

  await markJobStarted(jobId);
  logger.info({ jobId, type, projectId: job.projectId }, 'Job started');

  try {
    await handler(job);
    logger.info({ jobId, type }, 'Job completed');
  } catch (err) {
    const message = errorMessage(err);
    const cancelled = err instanceof Error && err.name === 'JobCancelled';

    if (cancelled) {
      await markJobFinished(job, 'cancelled', 'Cancelled by the user');
      await clearCancel(jobId);
      await setProjectStatus(job.projectId, 'draft', { errorMessage: null });
      return;
    }

    // BullMQ retries transient failures; only the final attempt marks the job
    // (and the project) as failed.
    const isFinalAttempt = bullJob.attemptsMade + 1 >= (bullJob.opts.attempts ?? 1);
    if (isFinalAttempt) {
      await markJobFinished(job, 'failed', message.slice(0, 2000));
      await setProjectStatus(job.projectId, 'failed', { errorMessage: message.slice(0, 2000) });
    }

    logger.error({ err, jobId, type, attempt: bullJob.attemptsMade + 1 }, 'Job failed');
    throw err;
  }
}

function concurrencyFor(queue: QueueName): number {
  switch (queue) {
    case QUEUE_NAMES.render:
      return env.RENDER_CONCURRENCY;
    case QUEUE_NAMES.generation:
      return env.GENERATION_CONCURRENCY;
    default:
      return env.ANALYSIS_CONCURRENCY;
  }
}

const workers: Worker<JobPayload>[] = [];

async function main(): Promise<void> {
  if (!(await ffmpegAvailable())) {
    logger.warn(
      { ffmpegPath: env.FFMPEG_PATH },
      'FFmpeg was not found — transcription and rendering will fail until it is installed',
    );
  }

  // A worker that died mid-job leaves rows stuck in a running state; put them
  // back on the queue so a restart recovers the project.
  const stale = await reclaimStaleJobs(30);
  for (const job of stale) {
    logger.warn({ jobId: job.id, type: job.type }, 'Re-queueing a job stranded by a worker restart');
    await requeueJob(job).catch((err) => logger.error({ err, jobId: job.id }, 'Re-queue failed'));
  }

  for (const name of Object.values(QUEUE_NAMES)) {
    const worker = new Worker<JobPayload>(name, processJob, {
      connection: createQueueConnection(`worker-${name}`),
      prefix: QUEUE_PREFIX,
      concurrency: concurrencyFor(name),
      // Long renders must not be reclaimed as stalled while they are working.
      lockDuration: 10 * 60_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    });

    worker.on('failed', (job, err) => {
      logger.error({ queue: name, jobId: job?.data?.jobId, err: err.message }, 'Queue job failed');
    });
    worker.on('error', (err) => logger.error({ queue: name, err }, 'Worker error'));

    workers.push(worker);
    logger.info({ queue: name, concurrency: concurrencyFor(name) }, 'Worker listening');
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down workers');
  await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
  await closeRedis();
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection in worker'));

main().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
