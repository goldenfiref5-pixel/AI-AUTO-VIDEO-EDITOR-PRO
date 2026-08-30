import { Router } from 'express';
import { z } from 'zod';
import {
  characterUpdateSchema,
  reorderScenesSchema,
  sceneUpdateSchema,
  splitSceneSchema,
  styleDnaUpdateSchema,
} from '@aiedit/shared';
import { authContext, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { badRequest } from '../utils/errors';
import { generateText } from '../gemini/service';
import { assetUrl, getAsset } from '../services/assets';
import {
  deleteCharacter,
  listCharacters,
  updateCharacter,
} from '../services/characters';
import { requireProject } from '../services/projects';
import { scoreProject } from '../services/quality';
import {
  deleteScene,
  listScenes,
  mergeScene,
  reorderScenes,
  requireScene,
  retimeScene,
  splitScene,
  updateScene,
} from '../services/scenes';
import { getStyleDna, updateStyleDna } from '../services/styleProfiles';
import { requireTranscript } from '../services/transcripts';

export const storyboardRouter = Router({ mergeParams: true });

storyboardRouter.use(requireAuth);

/** Attach signed URLs so the storyboard grid can render generated media. */
async function withMediaUrls(scenes: Awaited<ReturnType<typeof listScenes>>) {
  return Promise.all(
    scenes.map(async (scene) => {
      const [image, clip] = await Promise.all([
        scene.imageAssetId ? getAsset(scene.imageAssetId) : null,
        scene.clipAssetId ? getAsset(scene.clipAssetId) : null,
      ]);
      return {
        ...scene,
        imageUrl: image ? await assetUrl(image) : null,
        clipUrl: clip ? await assetUrl(clip) : null,
      };
    }),
  );
}

storyboardRouter.get(
  '/scenes',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    res.json({ scenes: await withMediaUrls(await listScenes(project.id)) });
  }),
);

storyboardRouter.patch(
  '/scenes/:sceneId',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const scene = await requireScene(req.params['sceneId']!, project.id);
    const input = sceneUpdateSchema.parse(req.body);

    if (input.startSec !== undefined && input.endSec !== undefined && input.endSec <= input.startSec) {
      throw badRequest('A scene must end after it starts.');
    }

    // Editing the prompt invalidates the generated media for that scene.
    const promptChanged =
      input.visualPrompt !== undefined || input.isBroll !== undefined || input.characterIds !== undefined;

    const updated = await updateScene(scene.id, {
      ...input,
      ...(promptChanged ? { status: 'planned' as const } : {}),
    });

    res.json({ scene: updated });
  }),
);

storyboardRouter.post(
  '/scenes/:sceneId/split',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const scene = await requireScene(req.params['sceneId']!, project.id);
    const { atSec } = splitSceneSchema.parse(req.body);

    res.json({ scenes: await withMediaUrls(await splitScene(scene, atSec)) });
  }),
);

storyboardRouter.post(
  '/scenes/:sceneId/merge',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const scene = await requireScene(req.params['sceneId']!, project.id);

    res.json({ scenes: await withMediaUrls(await mergeScene(scene)) });
  }),
);

storyboardRouter.delete(
  '/scenes/:sceneId',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const scene = await requireScene(req.params['sceneId']!, project.id);

    res.json({ scenes: await withMediaUrls(await deleteScene(scene)) });
  }),
);

storyboardRouter.post(
  '/scenes/reorder',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const { sceneIds } = reorderScenesSchema.parse(req.body);

    res.json({ scenes: await withMediaUrls(await reorderScenes(project.id, sceneIds)) });
  }),
);

const retimeSchema = z.object({ durationSec: z.number().min(0.2).max(120) });

storyboardRouter.post(
  '/scenes/:sceneId/retime',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const scene = await requireScene(req.params['sceneId']!, project.id);
    const { durationSec } = retimeSchema.parse(req.body);

    res.json({ scenes: await withMediaUrls(await retimeScene(scene, durationSec)) });
  }),
);

/**
 * Rewrite one scene's visual prompt without touching its narration or timing —
 * the "Regenerate Prompt" action on the storyboard review screen.
 */
storyboardRouter.post(
  '/scenes/:sceneId/regenerate-prompt',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const scene = await requireScene(req.params['sceneId']!, project.id);
    const styleDna = await getStyleDna(project.id);
    const characters = await listCharacters(project.id);

    const involved = characters.filter((c) => scene.characterIds.includes(c.id));
    const instruction = z
      .object({ instructions: z.string().max(1000).optional() })
      .parse(req.body ?? {}).instructions;

    const prompt = await generateText(
      { userId: project.userId, projectId: project.id },
      {
        system:
          'You write image generation prompts for a cinematic video production. Reply with the prompt text only — no preamble, no quotes, no explanation.',
        prompt: `Write a fresh visual prompt (30-60 words) for this scene.

Narration: "${scene.narration}"
Emotion: ${scene.emotion}
Location: ${scene.location}
Characters present: ${involved.map((c) => c.name).join(', ') || 'none'}
Current prompt (write something different but equally faithful): "${scene.visualPrompt}"
${instruction ? `User direction: ${instruction}` : ''}
${styleDna?.summary ? `Visual style to assume: ${styleDna.summary}` : ''}

Describe subject, action, environment, framing, lens and lighting. Do not mention captions, text or logos.`,
        temperature: 0.9,
        maxOutputTokens: 512,
      },
    );

    const updated = await updateScene(scene.id, {
      visualPrompt: prompt.trim().replace(/^["']|["']$/g, ''),
      status: 'planned',
    });

    res.json({ scene: updated });
  }),
);

// ---------------------------------------------------------------------------
// Characters and Style DNA
// ---------------------------------------------------------------------------

storyboardRouter.get(
  '/characters',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const characters = await listCharacters(project.id);

    const withSheets = await Promise.all(
      characters.map(async (character) => {
        const asset = character.referenceAssetId ? await getAsset(character.referenceAssetId) : null;
        return { ...character, referenceUrl: asset ? await assetUrl(asset) : null };
      }),
    );

    res.json({ characters: withSheets });
  }),
);

storyboardRouter.patch(
  '/characters/:characterId',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const input = characterUpdateSchema.parse(req.body);

    res.json({ character: await updateCharacter(req.params['characterId']!, project.id, input) });
  }),
);

storyboardRouter.delete(
  '/characters/:characterId',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    await deleteCharacter(req.params['characterId']!, project.id);
    res.status(204).end();
  }),
);

storyboardRouter.get(
  '/style-dna',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    res.json({ styleDna: await getStyleDna(project.id) });
  }),
);

storyboardRouter.patch(
  '/style-dna',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);
    const input = styleDnaUpdateSchema.parse(req.body);
    res.json({ styleDna: await updateStyleDna(project.id, input) });
  }),
);

/** Recompute the quality score on demand, before exporting. */
storyboardRouter.get(
  '/quality',
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const project = await requireProject(req.params['projectId']!, userId, isAdmin);

    const report = await scoreProject({
      project,
      transcript: await requireTranscript(project.id),
      scenes: await listScenes(project.id),
      characters: await listCharacters(project.id),
      styleDna: await getStyleDna(project.id),
    });

    res.json({ report });
  }),
);
