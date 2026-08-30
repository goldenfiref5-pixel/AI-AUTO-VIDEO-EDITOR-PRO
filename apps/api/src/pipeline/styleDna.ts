import type { StyleDna } from '@aiedit/shared';
import { analyzeImages } from '../gemini/service';
import { asArray, asString, parseJsonLoose } from '../utils/json';
import { STYLE_DNA_SYSTEM, styleDnaPrompt } from './prompts';

export interface StyleSourceImage {
  assetId: string;
  mimeType: string;
  data: Buffer;
}

export type StyleDnaDraft = Omit<StyleDna, 'id' | 'projectId' | 'createdAt' | 'locked'>;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Derive a reusable Style DNA profile from the user's reference images.
 *
 * The result is deliberately prompt-shaped: `promptSuffix` is appended verbatim
 * to every scene prompt, which is what actually makes generations look like
 * they came from one production.
 */
export async function buildStyleDna(params: {
  userId: string;
  projectId: string;
  images: StyleSourceImage[];
}): Promise<StyleDnaDraft> {
  const { images } = params;
  if (images.length === 0) {
    return fallbackStyleDna([]);
  }

  // Cap the payload: 12 frames is plenty to characterise a look and keeps the
  // request comfortably inside the inline-data budget.
  const sample = pickSpread(images, 12);

  const raw = await analyzeImages(
    { userId: params.userId, projectId: params.projectId },
    {
      images: sample.map((img) => ({ mimeType: img.mimeType, data: img.data })),
      prompt: styleDnaPrompt(sample.length),
      system: STYLE_DNA_SYSTEM,
    },
  );

  const parsed = parseJsonLoose<Record<string, unknown>>(raw);

  const palette = asArray<unknown>(parsed['colorPalette'])
    .map((c) => asString(c).trim())
    .filter((c) => HEX.test(c))
    .slice(0, 12);

  const draft: StyleDnaDraft = {
    name: asString(parsed['name'], 'Style DNA').slice(0, 120),
    summary: asString(parsed['summary']).slice(0, 4000),
    colorPalette: palette,
    colorGrading: asString(parsed['colorGrading']).slice(0, 600),
    lighting: asString(parsed['lighting']).slice(0, 600),
    composition: asString(parsed['composition']).slice(0, 600),
    cameraLens: asString(parsed['cameraLens']).slice(0, 240),
    cameraStyle: asString(parsed['cameraStyle']).slice(0, 600),
    mood: asString(parsed['mood']).slice(0, 240),
    realismLevel: asString(parsed['realismLevel'], 'photoreal').slice(0, 240),
    artisticStyle: asString(parsed['artisticStyle']).slice(0, 600),
    textureDetail: asString(parsed['textureDetail']).slice(0, 600),
    negativePrompt: asString(
      parsed['negativePrompt'],
      'text, watermark, logo, subtitles, distorted anatomy, extra fingers, blurry, low resolution',
    ).slice(0, 2000),
    promptSuffix: '',
    sourceAssetIds: images.map((i) => i.assetId),
  };

  const modelSuffix = asString(parsed['promptSuffix']).trim();
  draft.promptSuffix = modelSuffix || composeSuffix(draft);

  return draft;
}

/** Build a prompt fragment from the structured fields when the model omits one. */
export function composeSuffix(dna: Pick<
  StyleDnaDraft,
  | 'colorGrading'
  | 'lighting'
  | 'composition'
  | 'cameraLens'
  | 'cameraStyle'
  | 'mood'
  | 'realismLevel'
  | 'artisticStyle'
  | 'textureDetail'
  | 'colorPalette'
>): string {
  const fragments = [
    dna.realismLevel,
    dna.artisticStyle,
    dna.colorGrading,
    dna.lighting,
    dna.composition,
    dna.cameraLens,
    dna.cameraStyle,
    dna.textureDetail,
    dna.mood ? `mood: ${dna.mood}` : '',
    dna.colorPalette.length ? `palette: ${dna.colorPalette.join(', ')}` : '',
  ]
    .map((f) => f.trim())
    .filter(Boolean);

  return fragments.join(', ');
}

export function fallbackStyleDna(sourceAssetIds: string[]): StyleDnaDraft {
  const draft: StyleDnaDraft = {
    name: 'Cinematic Default',
    summary:
      'No style references were supplied, so the project uses a neutral cinematic look: filmic contrast, motivated lighting and natural colour.',
    colorPalette: ['#1B2430', '#2E4057', '#C9A227', '#E8E6E3', '#8A5A44'],
    colorGrading: 'filmic contrast curve, gentle highlight rolloff, teal shadows, warm skin tones',
    lighting: 'motivated key light, soft fill, subtle rim separation, natural practicals',
    composition: 'rule-of-thirds framing, layered foreground and background, generous negative space',
    cameraLens: '35mm to 50mm full-frame equivalent, f/2 shallow depth of field, mild vignette',
    cameraStyle: 'eye-level, steady, medium and medium-close shot sizes',
    mood: 'grounded, warm, cinematic',
    realismLevel: 'photoreal',
    artisticStyle: 'modern narrative cinema, digital cinema camera rendering',
    textureDetail: 'fine film grain, crisp micro-detail, subtle atmospheric haze',
    negativePrompt:
      'text, watermark, logo, subtitles, caption, distorted anatomy, extra fingers, extra limbs, blurry, low resolution, oversaturated, plastic skin',
    promptSuffix: '',
    sourceAssetIds,
  };
  draft.promptSuffix = composeSuffix(draft);
  return draft;
}

/** Evenly sample `count` items across the list rather than taking a prefix. */
function pickSpread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]!);
}
