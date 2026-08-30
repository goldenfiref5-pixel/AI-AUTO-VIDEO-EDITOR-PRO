import type {
  Asset,
  CharacterProfile,
  Project,
  Scene,
  StyleDna,
} from '@aiedit/shared';
import { imageResolutionFor } from '@aiedit/shared';
import { logger } from '../config/logger';
import { generateImage, generateVideoClip } from '../gemini/service';
import { GeminiError } from '../gemini/types';
import { assetBuffer, getAsset, storeBufferAsset } from '../services/assets';
import { setReferenceAsset } from '../services/characters';
import { retry } from '../utils/async';
import { brollPrompt, motionPromptFor, sceneImagePrompt } from './prompts';

export interface GenerationContext {
  project: Project;
  styleDna: StyleDna | null;
  /** Reference frames sampled from the user's style uploads. */
  styleReferences: Array<{ mimeType: string; data: Buffer }>;
  /** Character id -> canonical reference image, when a sheet exists. */
  characterReferences: Map<string, { mimeType: string; data: Buffer }>;
  characters: Map<string, CharacterProfile>;
}

/** How many reference images to attach to one generation request. */
const MAX_REFERENCES = 4;

function negativeFor(scene: Scene, styleDna: StyleDna | null): string {
  return [scene.negativePrompt, styleDna?.negativePrompt]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Render a character sheet: a single clean portrait that becomes the visual
 * anchor for every later scene featuring that person.
 *
 * This is the mechanism behind Character Lock. Text descriptions alone drift
 * between generations; passing the same reference image into every request is
 * what actually holds a face, outfit and build steady across 500 scenes.
 */
export async function generateCharacterSheet(
  context: GenerationContext,
  character: CharacterProfile,
): Promise<Asset> {
  const style = context.styleDna;
  const prompt = [
    `Character reference sheet for ${character.name}.`,
    character.canonicalPrompt,
    'Full-body three-quarter view, neutral standing pose, neutral expression, plain neutral studio background, even soft lighting, sharp focus on face and clothing detail.',
    style?.promptSuffix ? `STYLE: ${style.promptSuffix}` : '',
    'No text, no labels, no watermarks, no multiple panels — a single figure only.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const image = await retry(
    () =>
      generateImage(
        { userId: context.project.userId, projectId: context.project.id },
        {
          prompt,
          referenceImages: context.styleReferences.slice(0, 2),
          aspectRatio: '1:1',
        },
      ),
    {
      attempts: 3,
      baseDelayMs: 2000,
      shouldRetry: (err) => !(err instanceof GeminiError && err.failureClass === 'safety'),
      onRetry: (err, attempt) =>
        logger.warn({ characterId: character.id, attempt, err }, 'Retrying character sheet'),
    },
  );

  const asset = await storeBufferAsset(
    {
      userId: context.project.userId,
      projectId: context.project.id,
      kind: 'character_sheet',
      filename: `${slug(character.name)}-sheet.png`,
      mimeType: image.mimeType,
      metadata: { characterId: character.id, model: image.model },
    },
    image.data,
  );

  await setReferenceAsset(character.id, asset.id);
  context.characterReferences.set(character.id, { mimeType: image.mimeType, data: image.data });

  return asset;
}

/** Load existing character sheets so a resumed run does not regenerate them. */
export async function loadCharacterReferences(
  characters: readonly CharacterProfile[],
): Promise<Map<string, { mimeType: string; data: Buffer }>> {
  const map = new Map<string, { mimeType: string; data: Buffer }>();

  for (const character of characters) {
    if (!character.referenceAssetId) continue;
    try {
      const asset = await getAsset(character.referenceAssetId);
      if (!asset) continue;
      map.set(character.id, { mimeType: asset.mimeType, data: await assetBuffer(asset) });
    } catch (err) {
      logger.warn({ err, characterId: character.id }, 'Could not load character reference');
    }
  }

  return map;
}

export interface SceneImageResult {
  asset: Asset;
  prompt: string;
}

/**
 * Generate the still frame for one scene, conditioned on the Style DNA and on
 * every locked character that appears in it.
 */
export async function generateSceneImage(
  context: GenerationContext,
  scene: Scene,
): Promise<SceneImageResult> {
  const { project, styleDna } = context;
  const sceneCharacters = scene.characterIds
    .map((id) => context.characters.get(id))
    .filter((c): c is CharacterProfile => Boolean(c));

  const prompt = scene.isBroll
    ? brollPrompt({
        subject: scene.brollSubject ?? scene.visualPrompt,
        narration: scene.narration,
        styleSuffix: styleDna?.promptSuffix ?? '',
        aspectRatio: project.aspectRatio,
      })
    : sceneImagePrompt({
        visualPrompt: scene.visualPrompt,
        characterPrompts: sceneCharacters.map((c) => c.canonicalPrompt).filter(Boolean),
        styleSuffix: styleDna?.promptSuffix ?? '',
        aspectRatio: project.aspectRatio,
        emotion: scene.emotion,
        location: scene.location,
      });

  const negative = negativeFor(scene, styleDna);
  const fullPrompt = negative ? `${prompt}\n\nAVOID: ${negative}` : prompt;

  // Reference priority: characters first (identity matters most), then style.
  const references: Array<{ mimeType: string; data: Buffer }> = [];
  if (project.settings.characterLock) {
    for (const character of sceneCharacters) {
      const reference = context.characterReferences.get(character.id);
      if (reference) references.push(reference);
      if (references.length >= MAX_REFERENCES - 1) break;
    }
  }
  if (project.settings.styleLock) {
    references.push(...context.styleReferences.slice(0, MAX_REFERENCES - references.length));
  }

  const image = await retry(
    (attempt) =>
      generateImage(
        { userId: project.userId, projectId: project.id },
        {
          prompt: fullPrompt,
          referenceImages: references,
          aspectRatio: project.aspectRatio,
          // Nudge the sampler on a retry so a re-roll is not identical.
          temperature: 0.85 + (attempt - 1) * 0.05,
        },
      ),
    {
      attempts: 3,
      baseDelayMs: 2000,
      shouldRetry: (err) => !(err instanceof GeminiError && err.failureClass === 'safety'),
      onRetry: (err, attempt) =>
        logger.warn({ sceneId: scene.id, attempt, err }, 'Retrying scene image'),
    },
  );

  const resolution = imageResolutionFor(project.aspectRatio);
  const asset = await storeBufferAsset(
    {
      userId: project.userId,
      projectId: project.id,
      kind: scene.isBroll ? 'broll_image' : 'scene_image',
      filename: `scene-${String(scene.index).padStart(4, '0')}.png`,
      mimeType: image.mimeType,
      metadata: { sceneId: scene.id, model: image.model, resolution, prompt: fullPrompt.slice(0, 4000) },
    },
    image.data,
  );

  return { asset, prompt: fullPrompt };
}

/**
 * Animate a scene's still into a motion clip.
 *
 * Clips carry visuals only — the user's voiceover is the sole audio source, so
 * any audio the model returns is discarded during rendering.
 */
export async function generateSceneClip(
  context: GenerationContext,
  scene: Scene,
  image: { mimeType: string; data: Buffer },
): Promise<Asset> {
  const { project } = context;
  const durationSec = Math.max(1, scene.endSec - scene.startSec);

  const prompt = motionPromptFor({
    motionPrompt: scene.motionPrompt,
    cameraMotion: scene.cameraMotion,
    emotion: scene.emotion,
    narration: scene.narration,
  });

  const video = await retry(
    () =>
      generateVideoClip(
        { userId: project.userId, projectId: project.id },
        {
          prompt,
          image,
          durationSec,
          aspectRatio: project.aspectRatio,
          negativePrompt: negativeFor(scene, context.styleDna) || undefined,
        },
      ),
    {
      attempts: 2,
      baseDelayMs: 5000,
      shouldRetry: (err) => !(err instanceof GeminiError && err.failureClass === 'safety'),
      onRetry: (err, attempt) => logger.warn({ sceneId: scene.id, attempt, err }, 'Retrying scene clip'),
    },
  );

  return storeBufferAsset(
    {
      userId: project.userId,
      projectId: project.id,
      kind: scene.isBroll ? 'broll_clip' : 'scene_clip',
      filename: `scene-${String(scene.index).padStart(4, '0')}.mp4`,
      mimeType: video.mimeType,
      durationSec,
      metadata: { sceneId: scene.id, model: video.model, prompt: prompt.slice(0, 2000) },
    },
    video.data,
  );
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'character'
  );
}
