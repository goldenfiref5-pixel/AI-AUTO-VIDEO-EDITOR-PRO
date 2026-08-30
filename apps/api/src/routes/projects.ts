import { Router } from 'express';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import {
  DEFAULT_PROJECT_SETTINGS,
  LIMITS,
  batchGenerateSchema,
  competitorUrlSchema,
  createProjectSchema,
  enhanceTranscriptSchema,
  generateRequestSchema,
  paginationSchema,
  renderRequestSchema,
  searchReplaceSchema,
  updateProjectSchema,
  updateTranscriptSchema,
} from '@aiedit/shared';
import { allowQueryToken, authContext, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { uploadAudio, uploadImages, uploadVideo } from '../middleware/upload';
import { badRequest, notFound } from '../utils/errors';
import { deepMerge } from '../utils/json';
import { probeMedia } from '../render/ffmpeg';
import {
  assetUrl,
  deleteAsset,
  listProjectAssets,
  requireAsset,
  storeFileAsset,
} from '../services/assets';
import { listCharacters } from '../services/characters';
import {
  createProject,
  deleteProject,
  listProjects,
  requireProject,
  updateProject,
} from '../services/projects';
import { listProjectJobs } from '../services/jobs';
import { listRenders, latestCompletedRender } from '../services/renders';
import { listScenes } from '../services/scenes';
import {
  getStyleDna,
  listCompetitorInsights,
  deleteCompetitorInsight,
} from '../services/styleProfiles';
import {
  approveTranscript,
  editTranscript,
  getTranscript,
  listVersions,
  requireTranscript,
  restoreVersion,
  searchAndReplace,
  transcriptStats,
} from '../services/transcripts';
import {
  startGeneration,
  startRender,
  startStoryAnalysis,
  startTranscription,
} from '../services/pipeline';
import { enhanceScript } from '../services/scriptEnhancement';
import { lastProgress, subscribeToProject } from '../services/progress';
import { fetchRemoteVideo } from '../services/remoteVideo';

export const projectsRouter = Router();

// Must run before `requireAuth`: the SSE stream authenticates from the query
// string because EventSource cannot send an Authorization header.
projectsRouter.use((req, _res, next) => {
  if (req.path.endsWith('/progress')) allowQueryToken(req, _res, next);
  else next();
});

projectsRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

projectsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const { page, pageSize } = paginationSchema.parse(req.query);
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
    const search = typeof req.query['search'] === 'string' ? req.query['search'] : undefined;

    const result = await listProjects({
      userId,
      page,
      pageSize,
      status: status as never,
      search,
    });

    res.json({ ...result, page, pageSize });
  }),
);

projectsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const input = createProjectSchema.parse(req.body);

    const project = await createProject({
      userId,
      name: input.name,
      videoTitle: input.videoTitle ?? null,
      aspectRatio: input.aspectRatio,
      targetDurationSec: input.targetDurationSec ?? null,
      language: input.language,
      settings: deepMerge(DEFAULT_PROJECT_SETTINGS, input.settings ?? {}),
    });

    res.status(201).json({ project });
  }),
);

projectsRouter.get(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);

    const [transcript, styleDna, characters, scenes, insights, jobs, renders] = await Promise.all([
      getTranscript(project.id),
      getStyleDna(project.id),
      listCharacters(project.id),
      listScenes(project.id),
      listCompetitorInsights(project.id),
      listProjectJobs(project.id),
      listRenders(project.id),
    ]);

    res.json({
      project,
      transcript,
      transcriptStats: transcript ? transcriptStats(transcript) : null,
      styleDna,
      characters,
      scenes,
      competitorInsights: insights,
      jobs,
      renders,
    });
  }),
);

projectsRouter.patch(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const input = updateProjectSchema.parse(req.body);
    res.json({ project: await updateProject(project, input) });
  }),
);

projectsRouter.delete(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    await deleteProject(project.id);
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

projectsRouter.post(
  '/:projectId/voiceover',
  uploadAudio.single('file'),
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    if (!req.file) throw badRequest('No audio file was uploaded.');

    try {
      const info = await probeMedia(req.file.path);
      if (!info.hasAudio) throw badRequest('That file does not contain an audio track.');
      if (info.durationSec > LIMITS.maxAudioSeconds) {
        throw badRequest(
          `The voiceover is ${Math.round(info.durationSec / 60)} minutes long; the limit is ${
            LIMITS.maxAudioSeconds / 3600
          } hours.`,
        );
      }

      // A project has exactly one voiceover: replacing it invalidates the
      // transcript, so the old asset goes with it.
      for (const previous of await listProjectAssets(project.id, 'voiceover')) {
        await deleteAsset(previous.id);
      }

      const asset = await storeFileAsset(
        {
          userId,
          projectId: project.id,
          kind: 'voiceover',
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
          durationSec: info.durationSec,
          metadata: { sampleRate: info.sampleRate, channels: info.audioChannels },
        },
        req.file.path,
      );

      const job = await startTranscription(project, asset.id);
      res.status(201).json({ asset, job });
    } finally {
      await rm(req.file.path, { force: true }).catch(() => undefined);
    }
  }),
);

projectsRouter.post(
  '/:projectId/style-references',
  uploadImages.array('files', LIMITS.maxStyleReferences),
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw badRequest('No images were uploaded.');

    const existing = await listProjectAssets(project.id, 'style_reference');
    if (existing.length + files.length > LIMITS.maxStyleReferences) {
      throw badRequest(
        `A project accepts at most ${LIMITS.maxStyleReferences} style references (you already have ${existing.length}).`,
      );
    }

    const assets = [];
    try {
      for (const file of files) {
        assets.push(
          await storeFileAsset(
            {
              userId,
              projectId: project.id,
              kind: 'style_reference',
              filename: file.originalname,
              mimeType: file.mimetype,
            },
            file.path,
          ),
        );
      }
    } finally {
      await Promise.all(files.map((f) => rm(f.path, { force: true }).catch(() => undefined)));
    }

    res.status(201).json({ assets });
  }),
);

projectsRouter.post(
  '/:projectId/competitor-videos',
  uploadVideo.single('file'),
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    if (!req.file) throw badRequest('No video file was uploaded.');

    try {
      const existing = await listProjectAssets(project.id, 'competitor_video');
      if (existing.length >= LIMITS.maxCompetitorVideos) {
        throw badRequest(`A project accepts at most ${LIMITS.maxCompetitorVideos} reference videos.`);
      }

      const info = await probeMedia(req.file.path);
      if (!info.hasVideo) throw badRequest('That file does not contain a video track.');

      const asset = await storeFileAsset(
        {
          userId,
          projectId: project.id,
          kind: 'competitor_video',
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
          durationSec: info.durationSec,
          width: info.width,
          height: info.height,
        },
        req.file.path,
      );

      res.status(201).json({ asset });
    } finally {
      await rm(req.file.path, { force: true }).catch(() => undefined);
    }
  }),
);

/**
 * Register a competitor reference by URL.
 *
 * The file is fetched server side with a hard size and time budget, then stored
 * like any uploaded reference. Fetching here rather than in the worker means a
 * bad URL fails immediately, while the user is still looking at the form.
 */
projectsRouter.post(
  '/:projectId/competitor-urls',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const { url } = competitorUrlSchema.parse(req.body);

    const existing = await listProjectAssets(project.id, 'competitor_video');
    if (existing.length >= LIMITS.maxCompetitorVideos) {
      throw badRequest(`A project accepts at most ${LIMITS.maxCompetitorVideos} reference videos.`);
    }

    const download = await fetchRemoteVideo(url);
    try {
      const info = await probeMedia(download.filePath);
      if (!info.hasVideo) throw badRequest('That URL did not return a playable video.');

      const asset = await storeFileAsset(
        {
          userId,
          projectId: project.id,
          kind: 'competitor_video',
          filename: download.filename,
          mimeType: download.mimeType,
          durationSec: info.durationSec,
          width: info.width,
          height: info.height,
          metadata: { sourceUrl: url },
        },
        download.filePath,
      );

      res.status(201).json({ asset });
    } finally {
      await rm(download.filePath, { force: true }).catch(() => undefined);
    }
  }),
);

projectsRouter.get(
  '/:projectId/assets',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const kind = typeof req.query['kind'] === 'string' ? req.query['kind'] : undefined;

    const assets = await listProjectAssets(project.id, kind as never);
    const withUrls = await Promise.all(
      assets.map(async (asset) => ({ ...asset, url: await assetUrl(asset) })),
    );

    res.json({ assets: withUrls });
  }),
);

projectsRouter.delete(
  '/:projectId/assets/:assetId',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const asset = await requireAsset(req.params['assetId']!);
    if (asset.projectId !== project.id) throw notFound('Asset not found in this project');

    await deleteAsset(asset.id);
    res.status(204).end();
  }),
);

projectsRouter.delete(
  '/:projectId/competitor-insights/:insightId',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    await deleteCompetitorInsight(req.params['insightId']!, project.id);
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Transcript review and editing
// ---------------------------------------------------------------------------

projectsRouter.get(
  '/:projectId/transcript',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const transcript = await requireTranscript(project.id);

    res.json({
      transcript,
      stats: transcriptStats(transcript),
      versions: await listVersions(transcript.id),
    });
  }),
);

projectsRouter.put(
  '/:projectId/transcript',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const transcript = await requireTranscript(project.id);
    const input = updateTranscriptSchema.parse(req.body);

    const updated = await editTranscript(transcript, input);
    res.json({ transcript: updated, stats: transcriptStats(updated) });
  }),
);

projectsRouter.post(
  '/:projectId/transcript/enhance',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const transcript = await requireTranscript(project.id);
    const options = enhanceTranscriptSchema.parse(req.body ?? {});

    // The enhancement is returned as a proposal, not applied: the spec is
    // explicit that nothing changes without the user's approval.
    const proposal = await enhanceScript(project, transcript, options);
    res.json(proposal);
  }),
);

projectsRouter.post(
  '/:projectId/transcript/search-replace',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const transcript = await requireTranscript(project.id);
    const input = searchReplaceSchema.parse(req.body);

    const result = await searchAndReplace(transcript, input);
    res.json({
      transcript: result.transcript,
      replacements: result.replacements,
      stats: transcriptStats(result.transcript),
    });
  }),
);

projectsRouter.post(
  '/:projectId/transcript/restore/:version',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const transcript = await requireTranscript(project.id);
    const version = Number(req.params['version']);
    if (!Number.isInteger(version)) throw badRequest('Version must be an integer.');

    const restored = await restoreVersion(transcript, version);
    res.json({ transcript: restored, stats: transcriptStats(restored) });
  }),
);

/** "Proceed To Video Generation" — approves the transcript and plans scenes. */
projectsRouter.post(
  '/:projectId/transcript/approve',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const transcript = await requireTranscript(project.id);

    if (transcript.wordCount === 0) {
      throw badRequest('The transcript is empty — nothing to plan from.');
    }

    const approved = await approveTranscript(transcript.id);
    const jobs = await startStoryAnalysis(project);

    res.json({ transcript: approved, jobs });
  }),
);

// ---------------------------------------------------------------------------
// Generation, rendering and progress
// ---------------------------------------------------------------------------

projectsRouter.post(
  '/:projectId/generate',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const input = generateRequestSchema.parse(req.body ?? {});

    res.status(202).json({ jobs: await startGeneration(project, input) });
  }),
);

projectsRouter.post(
  '/:projectId/render',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const input = renderRequestSchema.parse(req.body ?? {});

    const { job, renderId } = await startRender(project, input);
    res.status(202).json({ job, renderId });
  }),
);

projectsRouter.get(
  '/:projectId/renders',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    res.json({
      renders: await listRenders(project.id),
      latest: await latestCompletedRender(project.id),
    });
  }),
);

projectsRouter.get(
  '/:projectId/jobs',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    res.json({ jobs: await listProjectJobs(project.id) });
  }),
);

/** Server-sent events: live pipeline progress for one project. */
projectsRouter.get(
  '/:projectId/progress',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const snapshot = await lastProgress(project.id);
    if (snapshot) res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

    const unsubscribe = subscribeToProject(project.id, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Proxies drop idle connections; a comment frame keeps the stream warm.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }),
);

/** Batch generation: queue the full generate + render pass for many projects. */
projectsRouter.post(
  '/batch/generate',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const input = batchGenerateSchema.parse(req.body);

    const results = [];
    for (const projectId of input.projectIds) {
      try {
        const project = await requireProject(projectId, userId, isAdmin);
        const jobs = await startGeneration(project, { force: false, priority: input.priority });
        const render = await startRender(project, { priority: (input.priority ?? 10) + 5 });
        results.push({ projectId, ok: true, jobIds: [...jobs.map((j) => j.id), render.job.id] });
      } catch (err) {
        results.push({
          projectId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    res.status(202).json({ results });
  }),
);

const exportQuerySchema = z.object({
  format: z.enum(['srt', 'vtt', 'txt', 'json']).default('srt'),
});

/** Download the caption track on its own. */
projectsRouter.get(
  '/:projectId/captions',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const transcript = await requireTranscript(project.id);
    const { format } = exportQuerySchema.parse(req.query);

    const { buildCues, buildSrtFile, buildVttFile } = await import('../render/captions');
    const words = transcript.segments.flatMap((s) => s.words);
    const cues = buildCues(words, project.settings.caption);

    const bodies: Record<string, () => string> = {
      srt: () => buildSrtFile(cues),
      vtt: () => buildVttFile(cues),
      txt: () => transcript.text,
      json: () => JSON.stringify({ segments: transcript.segments }, null, 2),
    };
    const types: Record<string, string> = {
      srt: 'application/x-subrip',
      vtt: 'text/vtt',
      txt: 'text/plain',
      json: 'application/json',
    };

    res.setHeader('Content-Type', `${types[format]}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="captions.${format}"`);
    res.send(bodies[format]!());
  }),
);
