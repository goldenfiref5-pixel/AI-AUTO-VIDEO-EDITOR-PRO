import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import {
  adminStats,
  adminUsers,
  recentFailures,
  systemHealth,
  usageTimeSeries,
} from '../services/admin';
import { pauseQueue, queueDepths, resumeQueue, QUEUE_NAMES } from '../queue/queues';
import { badRequest } from '../utils/errors';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

const windowSchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

adminRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const { days } = windowSchema.parse(req.query);
    res.json({ stats: await adminStats(days), windowDays: days });
  }),
);

adminRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const { days } = windowSchema.parse(req.query);
    res.json({ series: await usageTimeSeries(days) });
  }),
);

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { limit, offset } = listSchema.parse(req.query);
    res.json({ users: await adminUsers(limit, offset) });
  }),
);

adminRouter.get(
  '/failures',
  asyncHandler(async (req, res) => {
    const { limit } = listSchema.parse(req.query);
    res.json({ failures: await recentFailures(limit) });
  }),
);

adminRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    res.json(await systemHealth());
  }),
);

adminRouter.get(
  '/queues',
  asyncHandler(async (_req, res) => {
    res.json({ queues: await queueDepths() });
  }),
);

const queueActionSchema = z.object({
  queue: z.enum([QUEUE_NAMES.analysis, QUEUE_NAMES.generation, QUEUE_NAMES.render]),
  action: z.enum(['pause', 'resume']),
});

adminRouter.post(
  '/queues',
  asyncHandler(async (req, res) => {
    const { queue, action } = queueActionSchema.parse(req.body);
    if (action === 'pause') await pauseQueue(queue);
    else await resumeQueue(queue);

    res.json({ queues: await queueDepths() });
  }),
);

adminRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    // Deliberately reports capability and shape only — never secret values.
    const { env } = await import('../config/env');
    res.json({
      storageDriver: env.STORAGE_DRIVER,
      textModel: env.GEMINI_TEXT_MODEL,
      reasoningModel: env.GEMINI_REASONING_MODEL,
      imageModel: env.GEMINI_IMAGE_MODEL,
      videoModel: env.GEMINI_VIDEO_MODEL,
      transcribeModel: env.GEMINI_TRANSCRIBE_MODEL,
      renderConcurrency: env.RENDER_CONCURRENCY,
      generationConcurrency: env.GENERATION_CONCURRENCY,
      googleLoginEnabled: Boolean(env.GOOGLE_CLIENT_ID),
      fallbackKeyConfigured: Boolean(env.GEMINI_FALLBACK_API_KEY),
    });
  }),
);

adminRouter.post(
  '/queues/drain',
  asyncHandler(async (req, res) => {
    const parsed = z.object({ queue: z.string() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('A queue name is required.');
    throw badRequest(
      'Draining a queue discards queued work irrecoverably and is not exposed through the API. Pause the queue instead.',
    );
  }),
);
