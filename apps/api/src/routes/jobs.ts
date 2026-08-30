import { Router } from 'express';
import { paginationSchema } from '@aiedit/shared';
import { authContext, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { badRequest } from '../utils/errors';
import {
  listUserJobs,
  requestCancel,
  requireJob,
  resetJobForRetry,
  retryableJob,
} from '../services/jobs';
import { requeueJob } from '../services/pipeline';
import { pauseQueue, queueDepths, queueForJobType, removeQueueJob, resumeQueue } from '../queue/queues';

export const jobsRouter = Router();

jobsRouter.use(requireAuth);

jobsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const { page, pageSize } = paginationSchema.parse(req.query);
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;

    const result = await listUserJobs({ userId, page, pageSize, status: status as never });
    res.json({ ...result, page, pageSize });
  }),
);

jobsRouter.get(
  '/:jobId',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    res.json({ job: await requireJob(req.params['jobId']!, userId, isAdmin) });
  }),
);

jobsRouter.post(
  '/:jobId/cancel',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const job = await requireJob(req.params['jobId']!, userId, isAdmin);

    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      throw badRequest(`This job has already finished (${job.status}).`);
    }

    await requestCancel(job.id);
    // Removing it from the queue handles the not-yet-started case; a running
    // job notices the cancel flag at its next checkpoint.
    await removeQueueJob(job.type, job.id).catch(() => undefined);

    res.json({ job: await requireJob(job.id, userId, isAdmin) });
  }),
);

jobsRouter.post(
  '/:jobId/retry',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const job = await requireJob(req.params['jobId']!, userId, isAdmin);
    await retryableJob(job);

    const reset = await resetJobForRetry(job.id);
    await requeueJob(reset);

    res.json({ job: await requireJob(job.id, userId, isAdmin) });
  }),
);

/**
 * Pause and resume operate on the queue that serves this job type, which is
 * what BullMQ supports — an individual running job cannot be suspended.
 */
jobsRouter.post(
  '/:jobId/pause',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const job = await requireJob(req.params['jobId']!, userId, isAdmin);
    const queue = queueForJobType(job.type);
    await pauseQueue(queue);
    res.json({ paused: queue });
  }),
);

jobsRouter.post(
  '/:jobId/resume',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const job = await requireJob(req.params['jobId']!, userId, isAdmin);
    const queue = queueForJobType(job.type);
    await resumeQueue(queue);
    res.json({ resumed: queue });
  }),
);

jobsRouter.get(
  '/queues/depth',
  asyncHandler(async (_req, res) => {
    res.json({ queues: await queueDepths() });
  }),
);
