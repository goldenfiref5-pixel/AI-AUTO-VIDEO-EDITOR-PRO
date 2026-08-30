import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Job, Project, Scene } from '@aiedit/shared';
import { LIMITS } from '@aiedit/shared';
import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  assetBuffer,
  listProjectAssets,
  localCopy,
  requireAsset,
  storeFileAsset,
} from '../services/assets';
import { listCharacters, upsertCharacters } from '../services/characters';
import {
  assertNotCancelled,
  markJobFinished,
  updateJobProgress,
} from '../services/jobs';
import { requireProject, setProjectProgress, setProjectStatus, setQualityReport } from '../services/projects';
import { scoreProject } from '../services/quality';
import { listScenes, replaceScenes, updateScene, type SceneDraft } from '../services/scenes';
import {
  getStyleDna,
  insertCompetitorInsight,
  listCompetitorInsights,
  upsertStyleDna,
} from '../services/styleProfiles';
import { requireTranscript, upsertTranscript } from '../services/transcripts';
import { mapWithConcurrency } from '../utils/async';
import { errorMessage } from '../utils/errors';
import { renderProject, renderWorkDir, sceneCacheDir, type RenderScene } from '../render/renderer';
import { analyzeCompetitorVideo, derivePacingProfile } from './competitor';
import {
  generateCharacterSheet,
  generateSceneClip,
  generateSceneImage,
  loadCharacterReferences,
  type GenerationContext,
} from './generation';
import { analyzeStory } from './story';
import { buildStyleDna, fallbackStyleDna } from './styleDna';
import { transcribeAudio } from './transcription';
import { getRenderRecord, updateRenderRecord } from '../services/renders';

/** Per-job scratch space; always removed in a finally block. */
function jobWorkDir(job: Job): string {
  return path.join(path.resolve(env.RENDER_TMP_DIR), job.projectId, `job-${job.id}`);
}

async function progress(job: Job, fraction: number, message: string, status?: Job['status']): Promise<void> {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  await updateJobProgress(job, { progress: percent, message, status });
  await setProjectProgress(job.projectId, percent);
}

// ---------------------------------------------------------------------------
// Stage 1 — transcription
// ---------------------------------------------------------------------------

export async function runTranscribe(job: Job): Promise<void> {
  const project = await requireProject(job.projectId, job.userId, true);
  const workDir = jobWorkDir(job);

  try {
    await setProjectStatus(project.id, 'transcribing', { progress: 0, errorMessage: null });
    await progress(job, 0.02, 'Loading voiceover');

    const assetId = String(job.payload['assetId'] ?? '');
    const asset = assetId
      ? await requireAsset(assetId)
      : (await listProjectAssets(project.id, 'voiceover')).at(-1);

    if (!asset) throw new Error('No voiceover has been uploaded for this project.');

    const audioPath = await localCopy(asset, workDir);
    await assertNotCancelled(job.id);

    const result = await transcribeAudio({
      userId: project.userId,
      projectId: project.id,
      audioPath,
      languageHint: project.language,
      onProgress: (fraction, message) => {
        void progress(job, 0.05 + fraction * 0.9, message);
      },
    });

    if (result.wordCount > LIMITS.maxTranscriptWords) {
      logger.warn(
        { projectId: project.id, wordCount: result.wordCount },
        'Transcript exceeds the supported word count',
      );
    }

    await upsertTranscript({
      projectId: project.id,
      assetId: asset.id,
      language: result.language,
      text: result.text,
      segments: result.segments,
      wordCount: result.wordCount,
      durationSec: result.durationSec,
      confidence: result.confidence,
    });

    await setProjectStatus(project.id, 'transcript_ready', { progress: 100 });
    await markJobFinished(job, 'completed');
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Stage 2 — reference analysis (Style DNA + competitor grammar)
// ---------------------------------------------------------------------------

export async function runAnalyzeReferences(job: Job): Promise<void> {
  const project = await requireProject(job.projectId, job.userId, true);
  const workDir = jobWorkDir(job);

  try {
    await progress(job, 0.05, 'Reading style references');

    const styleAssets = await listProjectAssets(project.id, 'style_reference');
    const existingDna = await getStyleDna(project.id);

    // A locked Style DNA is the user's decision and is never recomputed.
    if (existingDna?.locked && existingDna.promptSuffix) {
      logger.info({ projectId: project.id }, 'Style DNA is locked; skipping re-analysis');
    } else if (styleAssets.length > 0) {
      const images = await mapWithConcurrency(styleAssets, 4, async (asset) => ({
        assetId: asset.id,
        mimeType: asset.mimeType,
        data: await assetBuffer(asset),
      }));
      await assertNotCancelled(job.id);
      const draft = await buildStyleDna({ userId: project.userId, projectId: project.id, images });
      await upsertStyleDna(project.id, draft);
    } else {
      await upsertStyleDna(project.id, fallbackStyleDna([]));
    }

    await progress(job, 0.5, 'Analysing competitor references');

    const videoAssets = await listProjectAssets(project.id, 'competitor_video');
    const analysed = await listCompetitorInsights(project.id);
    const analysedAssetIds = new Set(analysed.map((i) => i.assetId).filter(Boolean));

    const pending = videoAssets.filter((asset) => !analysedAssetIds.has(asset.id));
    for (let i = 0; i < pending.length; i += 1) {
      await assertNotCancelled(job.id);
      const asset = pending[i]!;
      await progress(job, 0.5 + (i / Math.max(1, pending.length)) * 0.45, `Analysing reference ${i + 1}`);

      try {
        const videoPath = await localCopy(asset, workDir);
        const draft = await analyzeCompetitorVideo({
          userId: project.userId,
          projectId: project.id,
          assetId: asset.id,
          sourceUrl: (asset.metadata['sourceUrl'] as string | undefined) ?? null,
          videoPath,
        });
        await insertCompetitorInsight(project.id, draft);
      } catch (err) {
        // One unreadable reference must not sink the whole project.
        logger.warn({ err, assetId: asset.id }, 'Competitor analysis failed for one reference');
      }
    }

    await markJobFinished(job, 'completed');
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — story analysis and storyboard construction
// ---------------------------------------------------------------------------

export async function runStoryAnalysis(job: Job): Promise<void> {
  const project = await requireProject(job.projectId, job.userId, true);
  await setProjectStatus(project.id, 'analyzing', { progress: 0, errorMessage: null });
  await progress(job, 0.03, 'Reading approved transcript');

  const transcript = await requireTranscript(project.id);
  if (!transcript.approvedAt) {
    throw new Error('The transcript must be approved before scenes can be planned.');
  }

  const styleDna = await getStyleDna(project.id);
  const insights = await listCompetitorInsights(project.id);
  const pacing = derivePacingProfile(insights, project.aspectRatio === '9:16' ? 3.5 : 5);

  await assertNotCancelled(job.id);

  const plan = await analyzeStory({
    userId: project.userId,
    projectId: project.id,
    segments: transcript.segments,
    durationSec: transcript.durationSec,
    targetDurationSec: project.targetDurationSec,
    aspectRatio: project.aspectRatio,
    language: transcript.language,
    styleSummary: styleDna?.summary ?? '',
    pacing,
    brollEnabled: project.settings.broll.enabled,
    brollCategories: project.settings.broll.categories,
    onProgress: (fraction, message) => {
      void progress(job, fraction, message);
    },
  });

  await progress(job, 0.9, 'Saving characters and storyboard');

  const characters = await upsertCharacters(project.id, plan.characters);

  const drafts: SceneDraft[] = plan.scenes.map((scene) => ({
    index: scene.index,
    startSec: scene.startSec,
    endSec: scene.endSec,
    narration: scene.narration,
    visualPrompt: scene.visualPrompt,
    negativePrompt: styleDna?.negativePrompt ?? null,
    emotion: scene.emotion,
    location: scene.location,
    characterIds: scene.characterNames
      .map((name) => characters.get(name.toLowerCase())?.id)
      .filter((id): id is string => Boolean(id)),
    cameraMotion: scene.cameraMotion,
    motionPrompt: scene.motionPrompt,
    isBroll: scene.isBroll,
    brollSubject: scene.brollSubject,
    words: scene.words,
  }));

  await replaceScenes(project.id, drafts);

  if (plan.warnings.length > 0) {
    logger.info({ projectId: project.id, warnings: plan.warnings }, 'Story plan warnings');
  }

  // Adopt the suggested title only when the user has not set one.
  if (!project.videoTitle && plan.title) {
    const { updateProject } = await import('../services/projects');
    await updateProject(project, { videoTitle: plan.title });
  }

  await setProjectStatus(project.id, 'storyboard_ready', { progress: 100 });
  await markJobFinished(job, 'completed');
}

// ---------------------------------------------------------------------------
// Stage 4 — image generation
// ---------------------------------------------------------------------------

async function buildGenerationContext(project: Project): Promise<GenerationContext> {
  const styleDna = await getStyleDna(project.id);
  const characters = await listCharacters(project.id);

  const styleAssets = (await listProjectAssets(project.id, 'style_reference')).slice(0, 3);
  const styleReferences = await mapWithConcurrency(styleAssets, 3, async (asset) => ({
    mimeType: asset.mimeType,
    data: await assetBuffer(asset),
  }));

  return {
    project,
    styleDna,
    styleReferences,
    characterReferences: await loadCharacterReferences(characters),
    characters: new Map(characters.map((c) => [c.id, c])),
  };
}

export async function runGenerateImages(job: Job): Promise<void> {
  const project = await requireProject(job.projectId, job.userId, true);
  await setProjectStatus(project.id, 'generating', { progress: 0, errorMessage: null });
  await progress(job, 0.02, 'Preparing generation context', 'generating_images');

  const context = await buildGenerationContext(project);
  const allScenes = await listScenes(project.id);
  if (allScenes.length === 0) throw new Error('This project has no storyboard to generate from.');

  const force = Boolean(job.payload['force']);
  const requestedIds = new Set((job.payload['sceneIds'] as string[] | undefined) ?? []);
  const scenes = allScenes.filter((scene) => {
    if (requestedIds.size > 0) return requestedIds.has(scene.id);
    return force || !scene.imageAssetId || scene.status === 'failed';
  });

  // Character sheets first: every scene image is conditioned on them, so they
  // must exist before any scene is generated.
  if (project.settings.characterLock) {
    const needSheets = [...context.characters.values()].filter(
      (character) => !context.characterReferences.has(character.id),
    );
    for (let i = 0; i < needSheets.length; i += 1) {
      await assertNotCancelled(job.id);
      const character = needSheets[i]!;
      await progress(
        job,
        0.02 + (i / Math.max(1, needSheets.length)) * 0.12,
        `Generating character sheet for ${character.name}`,
        'generating_images',
      );
      try {
        await generateCharacterSheet(context, character);
      } catch (err) {
        logger.warn({ err, characterId: character.id }, 'Character sheet generation failed');
      }
    }
  }

  await updateJobProgress(job, { total: scenes.length, completed: 0, failed: 0, status: 'generating_images' });

  let completed = 0;
  let failed = 0;

  await mapWithConcurrency(scenes, env.GENERATION_CONCURRENCY, async (scene) => {
    await assertNotCancelled(job.id);
    try {
      await updateScene(scene.id, { status: 'image_queued', errorMessage: null });
      const { asset } = await generateSceneImage(context, scene);
      await updateScene(scene.id, {
        status: 'image_ready',
        imageAssetId: asset.id,
        errorMessage: null,
      });
      completed += 1;
    } catch (err) {
      failed += 1;
      const message = errorMessage(err);
      logger.warn({ err, sceneId: scene.id }, 'Scene image generation failed');
      await updateScene(scene.id, { status: 'failed', errorMessage: message.slice(0, 500) });
    } finally {
      await updateJobProgress(job, {
        progress: Math.round(((completed + failed) / Math.max(1, scenes.length)) * 100),
        completed,
        failed,
        message: `Generated ${completed}/${scenes.length} images`,
      });
      await setProjectProgress(
        project.id,
        Math.round(((completed + failed) / Math.max(1, scenes.length)) * 100),
      );
    }
  });

  if (failed === scenes.length && scenes.length > 0) {
    throw new Error(`All ${scenes.length} scene images failed to generate. Check API Management for key status.`);
  }

  await markJobFinished(job, 'completed');
}

// ---------------------------------------------------------------------------
// Stage 5 — motion clip generation
// ---------------------------------------------------------------------------

export async function runGenerateClips(job: Job): Promise<void> {
  const project = await requireProject(job.projectId, job.userId, true);

  if (!project.settings.motionEnabled) {
    await updateJobProgress(job, { message: 'Motion generation is disabled; using Ken Burns moves on stills.' });
    await markJobFinished(job, 'completed');
    return;
  }

  await progress(job, 0.02, 'Preparing motion generation', 'generating_video');
  const context = await buildGenerationContext(project);

  const allScenes = await listScenes(project.id);
  const force = Boolean(job.payload['force']);
  const requestedIds = new Set((job.payload['sceneIds'] as string[] | undefined) ?? []);

  const scenes = allScenes.filter((scene) => {
    if (!scene.imageAssetId) return false;
    if (requestedIds.size > 0) return requestedIds.has(scene.id);
    return force || !scene.clipAssetId;
  });

  await updateJobProgress(job, { total: scenes.length, completed: 0, failed: 0, status: 'generating_video' });

  let completed = 0;
  let failed = 0;

  // Video generation is far more expensive than images, so it runs at half the
  // image concurrency to leave key quota for everything else.
  const concurrency = Math.max(1, Math.floor(env.GENERATION_CONCURRENCY / 2));

  await mapWithConcurrency(scenes, concurrency, async (scene) => {
    await assertNotCancelled(job.id);
    try {
      await updateScene(scene.id, { status: 'clip_queued' });
      const imageAsset = await requireAsset(scene.imageAssetId!);
      const asset = await generateSceneClip(context, scene, {
        mimeType: imageAsset.mimeType,
        data: await assetBuffer(imageAsset),
      });
      await updateScene(scene.id, { status: 'clip_ready', clipAssetId: asset.id, errorMessage: null });
      completed += 1;
    } catch (err) {
      failed += 1;
      // A missing clip is recoverable: the renderer falls back to a Ken Burns
      // move on the still, so the scene keeps its slot in the timeline.
      logger.warn({ err, sceneId: scene.id }, 'Scene clip generation failed; falling back to still');
      await updateScene(scene.id, {
        status: 'image_ready',
        errorMessage: `Motion clip failed: ${errorMessage(err).slice(0, 400)}`,
      });
    } finally {
      await updateJobProgress(job, {
        progress: Math.round(((completed + failed) / Math.max(1, scenes.length)) * 100),
        completed,
        failed,
        message: `Animated ${completed}/${scenes.length} scenes`,
      });
    }
  });

  await markJobFinished(job, 'completed');
}

// ---------------------------------------------------------------------------
// Stage 6 — render and export
// ---------------------------------------------------------------------------

export async function runRender(job: Job): Promise<void> {
  const project = await requireProject(job.projectId, job.userId, true);
  const renderId = String(job.payload['renderId'] ?? '');
  const record = renderId ? await getRenderRecord(renderId) : null;

  await setProjectStatus(project.id, 'rendering', { progress: 0, errorMessage: null });
  await progress(job, 0.02, 'Collecting scene media', 'rendering');

  const transcript = await requireTranscript(project.id);
  const scenes = await listScenes(project.id);
  if (scenes.length === 0) throw new Error('This project has no scenes to render.');

  const workDir = renderWorkDir(project.id, job.id);
  const mediaDir = path.join(workDir, 'media');
  await mkdir(mediaDir, { recursive: true });

  const controller = new AbortController();
  const cancelPoll = setInterval(() => {
    void assertNotCancelled(job.id).catch(() => controller.abort());
  }, 5000);

  try {
    const voiceover = (await listProjectAssets(project.id, 'voiceover')).at(-1);
    if (!voiceover) throw new Error('The voiceover asset is missing.');
    const audioPath = await localCopy(voiceover, mediaDir);

    const renderScenes: RenderScene[] = await mapWithConcurrency(scenes, 6, async (scene) =>
      toRenderScene(scene, mediaDir),
    );

    const exportSettings = {
      format: (record?.format ?? project.settings.export.format),
      resolution: (record?.resolution ?? project.settings.export.resolution),
      fps: (record?.fps ?? project.settings.export.fps),
    };

    const outputPath = path.join(
      workDir,
      `${slugify(project.videoTitle ?? project.name)}-${exportSettings.resolution}.${exportSettings.format}`,
    );

    const result = await renderProject({
      projectId: project.id,
      scenes: renderScenes,
      audioPath,
      words: transcript.segments.flatMap((s) => s.words),
      language: transcript.language,
      aspectRatio: project.aspectRatio,
      resolution: exportSettings.resolution,
      format: exportSettings.format,
      fps: exportSettings.fps,
      videoBitrateKbps: project.settings.export.videoBitrateKbps,
      audioBitrateKbps: project.settings.export.audioBitrateKbps,
      caption: project.settings.caption,
      transition: project.settings.transition,
      workDir,
      sceneCacheDir: sceneCacheDir(project.id),
      outputPath,
      signal: controller.signal,
      onProgress: (fraction, message) => {
        void progress(job, fraction, message, 'rendering');
      },
    });

    await progress(job, 0.99, 'Uploading final video');

    const asset = await storeFileAsset(
      {
        userId: project.userId,
        projectId: project.id,
        kind: 'render_output',
        filename: path.basename(outputPath),
        mimeType: mimeForFormat(exportSettings.format),
        durationSec: result.durationSec,
        width: result.width,
        height: result.height,
        metadata: { renderId, fps: exportSettings.fps, resolution: exportSettings.resolution },
      },
      outputPath,
    );

    const report = await scoreProject({
      project,
      transcript,
      scenes,
      characters: await listCharacters(project.id),
      styleDna: await getStyleDna(project.id),
      renderedDurationSec: result.durationSec,
      downgradedTransitions: result.downgradedTransitions,
    });

    await setQualityReport(project.id, report);

    if (record) {
      await updateRenderRecord(record.id, {
        status: 'completed',
        assetId: asset.id,
        bytes: result.bytes,
        durationSec: result.durationSec,
        qualityReport: report,
      });
    }

    await setProjectStatus(project.id, 'completed', { progress: 100 });
    await markJobFinished(job, 'completed');
  } catch (err) {
    if (record) {
      await updateRenderRecord(record.id, { status: 'failed' }).catch(() => undefined);
    }
    throw err;
  } finally {
    clearInterval(cancelPoll);
    // The scene cache lives one level up and deliberately survives, so a retry
    // does not re-encode every clip.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function toRenderScene(scene: Scene, mediaDir: string): Promise<RenderScene> {
  let clipPath: string | null = null;
  let imagePath: string | null = null;

  if (scene.clipAssetId) {
    try {
      clipPath = await localCopy(await requireAsset(scene.clipAssetId), mediaDir);
    } catch (err) {
      logger.warn({ err, sceneId: scene.id }, 'Scene clip could not be fetched');
    }
  }
  if (scene.imageAssetId) {
    try {
      imagePath = await localCopy(await requireAsset(scene.imageAssetId), mediaDir);
    } catch (err) {
      logger.warn({ err, sceneId: scene.id }, 'Scene image could not be fetched');
    }
  }

  return {
    id: scene.id,
    index: scene.index,
    startSec: scene.startSec,
    endSec: scene.endSec,
    cameraMotion: scene.cameraMotion,
    emotion: scene.emotion,
    location: scene.location,
    transitionIn: scene.transitionIn,
    clipPath,
    imagePath,
  };
}

function mimeForFormat(format: string): string {
  switch (format) {
    case 'mov':
      return 'video/quicktime';
    case 'webm':
      return 'video/webm';
    default:
      return 'video/mp4';
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'video'
  );
}
