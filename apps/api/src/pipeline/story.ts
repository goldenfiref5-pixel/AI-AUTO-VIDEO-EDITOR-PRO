import type { CameraMotion, TranscriptSegment, TranscriptWord } from '@aiedit/shared';
import { CAMERA_MOTIONS, LIMITS } from '@aiedit/shared';
import { logger } from '../config/logger';
import { generateJson } from '../gemini/service';
import { env } from '../config/env';
import { asArray, asBoolean, asNumber, asString } from '../utils/json';
import { normalizeForMatch, tokenizeWords } from '../utils/text';
import type { PacingProfile } from './competitor';
import { STORY_ANALYSIS_SYSTEM, storyAnalysisPrompt } from './prompts';

export interface PlannedCharacter {
  name: string;
  role: string;
  age: string;
  gender: string;
  skinTone: string;
  hair: string;
  face: string;
  bodyShape: string;
  clothing: string;
  accessories: string;
  canonicalPrompt: string;
}

export interface PlannedScene {
  index: number;
  narration: string;
  visualPrompt: string;
  emotion: string;
  location: string;
  characterNames: string[];
  cameraMotion: CameraMotion;
  motionPrompt: string | null;
  isBroll: boolean;
  brollSubject: string | null;
  weight: number;
  startSec: number;
  endSec: number;
  words: TranscriptWord[];
}

export interface StoryPlan {
  title: string;
  logline: string;
  storyArc: string[];
  characters: PlannedCharacter[];
  locations: Array<{ name: string; description: string }>;
  scenes: PlannedScene[];
  warnings: string[];
}

export interface StoryAnalysisInput {
  userId: string;
  projectId: string;
  segments: TranscriptSegment[];
  durationSec: number;
  targetDurationSec: number | null;
  aspectRatio: string;
  language: string;
  styleSummary: string;
  pacing: PacingProfile;
  brollEnabled: boolean;
  brollCategories: string[];
  onProgress?: (fraction: number, message: string) => void;
}

/** Words per planning call. Keeps the model's output inside its token budget. */
const WORDS_PER_CHUNK = 3500;

export async function analyzeStory(input: StoryAnalysisInput): Promise<StoryPlan> {
  const words = input.segments.flatMap((s) => s.words);
  if (words.length === 0) {
    throw new Error('The transcript has no timed words — re-run transcription before planning scenes.');
  }

  const chunks = chunkSegments(input.segments, WORDS_PER_CHUNK);
  logger.info(
    { projectId: input.projectId, words: words.length, chunks: chunks.length },
    'Planning scenes',
  );

  const warnings: string[] = [];
  const characters = new Map<string, PlannedCharacter>();
  const locations = new Map<string, string>();
  const rawScenes: RawScene[] = [];
  let title = '';
  let logline = '';
  let storyArc: string[] = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    input.onProgress?.(
      0.1 + (i / chunks.length) * 0.7,
      `Planning scenes ${i + 1}/${chunks.length}`,
    );

    const chunkDuration = chunk.endSec - chunk.startSec;
    const targetSceneCount = planSceneCount(chunkDuration, input.pacing.avgSceneDurationSec);

    const continuity =
      characters.size > 0
        ? `\n\nCONTINUITY — these characters already exist and MUST be reused with the exact same names and appearance:\n${JSON.stringify(
            [...characters.values()].map((c) => ({ name: c.name, canonicalPrompt: c.canonicalPrompt })),
            null,
            2,
          )}`
        : '';

    const response = await generateJson<RawPlan>(
      { userId: input.userId, projectId: input.projectId },
      {
        prompt:
          storyAnalysisPrompt({
            transcript: chunk.text,
            durationSec: chunkDuration,
            targetSceneCount,
            minSceneSec: LIMITS.minSceneDurationSec,
            maxSceneSec: LIMITS.maxSceneDurationSec,
            aspectRatio: input.aspectRatio,
            language: input.language,
            styleSummary: input.styleSummary,
            pacingGuidance:
              i === 0
                ? `${input.pacing.guidance} ${input.pacing.hookGuidance}`
                : input.pacing.guidance,
            brollCategories: input.brollEnabled ? input.brollCategories : [],
          }) + continuity,
        system: STORY_ANALYSIS_SYSTEM,
        model: env.GEMINI_REASONING_MODEL,
        temperature: 0.6,
        maxOutputTokens: env.GEMINI_MAX_OUTPUT_TOKENS,
      },
    );

    if (i === 0) {
      title = asString(response.title).slice(0, 240);
      logline = asString(response.logline).slice(0, 600);
      storyArc = asArray<unknown>(response.storyArc).map((a) => asString(a)).filter(Boolean);
    }

    for (const raw of asArray<Record<string, unknown>>(response.characters)) {
      const character = normalizeCharacter(raw);
      if (!character) continue;
      // First definition wins: later chunks must not redesign an existing person.
      if (!characters.has(character.name.toLowerCase())) {
        characters.set(character.name.toLowerCase(), character);
      }
    }

    for (const raw of asArray<Record<string, unknown>>(response.locations)) {
      const name = asString(raw['name']).trim();
      if (name && !locations.has(name.toLowerCase())) {
        locations.set(name.toLowerCase(), asString(raw['description']).slice(0, 600));
      }
    }

    const chunkScenes = asArray<Record<string, unknown>>(response.scenes)
      .map((raw) => normalizeScene(raw, [...characters.values()]))
      .filter((s): s is RawScene => s !== null);

    if (chunkScenes.length === 0) {
      warnings.push(`The planner returned no scenes for narration chunk ${i + 1}; it was split evenly instead.`);
      rawScenes.push(...fallbackScenes(chunk.text, targetSceneCount));
    } else {
      rawScenes.push(...chunkScenes);
    }
  }

  input.onProgress?.(0.85, 'Aligning scenes to the narration timeline');

  const scenes = assignTiming(rawScenes, words, input.durationSec, warnings);
  const balanced = enforceDurationBounds(scenes, input.durationSec);

  if (balanced.length > LIMITS.maxScenesPerProject) {
    warnings.push(
      `The plan produced ${balanced.length} scenes; the last ${
        balanced.length - LIMITS.maxScenesPerProject
      } were merged to stay within the ${LIMITS.maxScenesPerProject}-scene limit.`,
    );
  }

  if (input.targetDurationSec) {
    const delta = input.targetDurationSec - input.durationSec;
    if (Math.abs(delta) / input.durationSec > 0.1) {
      warnings.push(
        `Requested duration is ${input.targetDurationSec}s but the voiceover runs ${input.durationSec.toFixed(
          1,
        )}s. The video follows the narration; ${
          delta > 0 ? 'the final scene is held to cover the difference' : 'the target was treated as guidance only'
        }.`,
      );
    }
  }

  return {
    title,
    logline,
    storyArc,
    characters: [...characters.values()],
    locations: [...locations.entries()].map(([key, description]) => ({
      name: [...locations.keys()].includes(key) ? capitalize(key) : key,
      description,
    })),
    scenes: balanced.slice(0, LIMITS.maxScenesPerProject),
    warnings,
  };
}

interface RawPlan {
  title?: unknown;
  logline?: unknown;
  storyArc?: unknown;
  characters?: unknown;
  locations?: unknown;
  scenes?: unknown;
}

interface RawScene {
  narration: string;
  visualPrompt: string;
  emotion: string;
  location: string;
  characterNames: string[];
  cameraMotion: CameraMotion;
  motionPrompt: string | null;
  isBroll: boolean;
  brollSubject: string | null;
  weight: number;
}

interface Chunk {
  text: string;
  startSec: number;
  endSec: number;
}

function chunkSegments(segments: readonly TranscriptSegment[], wordsPerChunk: number): Chunk[] {
  const chunks: Chunk[] = [];
  let buffer: TranscriptSegment[] = [];
  let wordCount = 0;

  for (const segment of segments) {
    buffer.push(segment);
    wordCount += segment.words.length || tokenizeWords(segment.text).length;
    if (wordCount >= wordsPerChunk) {
      chunks.push(toChunk(buffer));
      buffer = [];
      wordCount = 0;
    }
  }
  if (buffer.length) chunks.push(toChunk(buffer));
  return chunks.length ? chunks : [{ text: '', startSec: 0, endSec: 0 }];
}

function toChunk(segments: readonly TranscriptSegment[]): Chunk {
  return {
    text: segments.map((s) => s.text.trim()).join(' '),
    startSec: segments[0]?.start ?? 0,
    endSec: segments[segments.length - 1]?.end ?? 0,
  };
}

function planSceneCount(durationSec: number, avgSceneSec: number): number {
  const target = Math.round(durationSec / Math.max(1.5, avgSceneSec));
  return Math.max(1, Math.min(LIMITS.maxScenesPerProject, target));
}

function normalizeCharacter(raw: Record<string, unknown>): PlannedCharacter | null {
  const name = asString(raw['name']).trim();
  if (!name) return null;

  const character: PlannedCharacter = {
    name: name.slice(0, 120),
    role: asString(raw['role'], 'supporting').slice(0, 160),
    age: asString(raw['age']).slice(0, 60),
    gender: asString(raw['gender'], 'unspecified').slice(0, 60),
    skinTone: asString(raw['skinTone']).slice(0, 120),
    hair: asString(raw['hair']).slice(0, 240),
    face: asString(raw['face']).slice(0, 480),
    bodyShape: asString(raw['bodyShape']).slice(0, 240),
    clothing: asString(raw['clothing']).slice(0, 480),
    accessories: asString(raw['accessories']).slice(0, 240),
    canonicalPrompt: asString(raw['canonicalPrompt']).slice(0, 4000),
  };

  if (!character.canonicalPrompt) {
    character.canonicalPrompt = composeCanonicalPrompt(character);
  }
  return character;
}

/** Build the identity lock-in string when the model does not supply one. */
export function composeCanonicalPrompt(c: Omit<PlannedCharacter, 'canonicalPrompt'>): string {
  return [
    c.name,
    c.age,
    c.gender && c.gender !== 'unspecified' ? c.gender : '',
    c.skinTone ? `${c.skinTone} skin` : '',
    c.hair ? `${c.hair} hair` : '',
    c.face,
    c.bodyShape,
    c.clothing ? `wearing ${c.clothing}` : '',
    c.accessories ? `with ${c.accessories}` : '',
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

function normalizeScene(
  raw: Record<string, unknown>,
  knownCharacters: readonly PlannedCharacter[],
): RawScene | null {
  const narration = asString(raw['narration']).trim();
  const visualPrompt = asString(raw['visualPrompt']).trim();
  if (!narration && !visualPrompt) return null;

  const motionRaw = asString(raw['cameraMotion'], 'push_in').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const cameraMotion = (CAMERA_MOTIONS as readonly string[]).includes(motionRaw)
    ? (motionRaw as CameraMotion)
    : 'push_in';

  // Only keep names that match a character we actually know about.
  const known = new Map(knownCharacters.map((c) => [c.name.toLowerCase(), c.name]));
  const characterNames = asArray<unknown>(raw['characters'])
    .map((n) => asString(n).trim())
    .map((n) => known.get(n.toLowerCase()))
    .filter((n): n is string => Boolean(n));

  const isBroll = asBoolean(raw['isBroll'], false) && characterNames.length === 0;

  return {
    narration,
    visualPrompt: visualPrompt || narration,
    emotion: asString(raw['emotion'], 'neutral').slice(0, 120),
    location: asString(raw['location']).slice(0, 240),
    characterNames,
    cameraMotion,
    motionPrompt: asString(raw['motionPrompt']).trim() || null,
    isBroll,
    brollSubject: isBroll ? asString(raw['brollSubject']).slice(0, 240) || null : null,
    weight: clamp(asNumber(raw['weight'], 1), 0.4, 2.5),
  };
}

function fallbackScenes(text: string, count: number): RawScene[] {
  const tokens = tokenizeWords(text);
  const per = Math.max(1, Math.ceil(tokens.length / Math.max(1, count)));
  const scenes: RawScene[] = [];

  for (let i = 0; i < tokens.length; i += per) {
    const narration = tokens.slice(i, i + per).join(' ');
    scenes.push({
      narration,
      visualPrompt: `Cinematic establishing shot illustrating: ${narration}`,
      emotion: 'neutral',
      location: '',
      characterNames: [],
      cameraMotion: 'push_in',
      motionPrompt: null,
      isBroll: false,
      brollSubject: null,
      weight: 1,
    });
  }
  return scenes;
}

/**
 * Walk the narration word stream and hand each scene the words it covers.
 *
 * The model is asked for verbatim slices, but it paraphrases often enough that
 * a strict match is not safe. Instead we consume the word stream greedily: each
 * scene claims as many words as its narration contains, with a lookahead
 * resync so one bad slice does not desynchronise everything after it.
 */
function assignTiming(
  scenes: readonly RawScene[],
  words: readonly TranscriptWord[],
  durationSec: number,
  warnings: string[],
): PlannedScene[] {
  const normalizedStream = words.map((w) => normalizeForMatch(w.text));
  const result: PlannedScene[] = [];
  let cursor = 0;
  let desyncs = 0;

  scenes.forEach((scene, index) => {
    const sceneTokens = tokenizeWords(scene.narration).map(normalizeForMatch).filter(Boolean);
    const remainingScenes = scenes.length - index;
    const remainingWords = words.length - cursor;

    if (remainingWords <= 0) return;

    let take: number;
    if (sceneTokens.length === 0) {
      // No narration text (pure B-roll insert): give it an even share.
      take = Math.max(1, Math.floor(remainingWords / remainingScenes));
    } else {
      const anchored = findAnchor(normalizedStream, sceneTokens, cursor);
      if (anchored !== null && anchored > cursor) {
        // The previous scene under-claimed: absorb the gap rather than lose it.
        result[result.length - 1]?.words.push(...words.slice(cursor, anchored));
        cursor = anchored;
        desyncs += 1;
      }
      take = Math.min(sceneTokens.length, remainingWords);
    }

    // Never strand the tail: the last scene takes everything that is left.
    if (index === scenes.length - 1) take = remainingWords;

    const claimed = words.slice(cursor, cursor + take);
    cursor += take;
    if (claimed.length === 0) return;

    result.push({
      index: result.length,
      narration: scene.narration || claimed.map((w) => w.text).join(' '),
      visualPrompt: scene.visualPrompt,
      emotion: scene.emotion,
      location: scene.location,
      characterNames: scene.characterNames,
      cameraMotion: scene.cameraMotion,
      motionPrompt: scene.motionPrompt,
      isBroll: scene.isBroll,
      brollSubject: scene.brollSubject,
      weight: scene.weight,
      startSec: claimed[0]!.start,
      endSec: claimed[claimed.length - 1]!.end,
      words: claimed,
    });
  });

  // Anything left over (model returned too few scenes) becomes a final scene.
  if (cursor < words.length && result.length > 0) {
    const tail = words.slice(cursor);
    const last = result[result.length - 1]!;
    last.words = [...last.words, ...tail];
    last.narration = `${last.narration} ${tail.map((w) => w.text).join(' ')}`.trim();
    last.endSec = tail[tail.length - 1]!.end;
  }

  if (desyncs > 0) {
    warnings.push(
      `${desyncs} scene${desyncs === 1 ? '' : 's'} did not match the narration verbatim and were re-anchored to the audio.`,
    );
  }

  return makeContiguous(result, durationSec);
}

/**
 * Look for the scene's opening words a little further along the stream, so a
 * dropped or paraphrased word does not shift every later scene.
 */
function findAnchor(
  stream: readonly string[],
  sceneTokens: readonly string[],
  from: number,
): number | null {
  const probe = sceneTokens.slice(0, 3).filter(Boolean);
  if (probe.length < 2) return null;

  const limit = Math.min(stream.length - probe.length, from + 40);
  for (let i = from; i <= limit; i += 1) {
    let matched = true;
    for (let j = 0; j < probe.length; j += 1) {
      if (stream[i + j] !== probe[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return null;
}

/** Close the sub-second gaps between words so scenes tile the timeline exactly. */
function makeContiguous(scenes: PlannedScene[], durationSec: number): PlannedScene[] {
  scenes.forEach((scene, index) => {
    scene.index = index;
    scene.startSec = index === 0 ? 0 : scenes[index - 1]!.endSec;
    const next = scenes[index + 1];
    scene.endSec = next ? Math.max(scene.endSec, scene.startSec + 0.2) : Math.max(durationSec, scene.startSec + 0.2);
  });

  // Second pass: a scene's end is the next scene's start.
  for (let i = 0; i < scenes.length - 1; i += 1) {
    scenes[i]!.endSec = scenes[i + 1]!.startSec;
  }
  const last = scenes[scenes.length - 1];
  if (last) last.endSec = Math.max(durationSec, last.startSec + 0.5);

  return scenes;
}

/**
 * Merge shots that are too short to read and split ones that overstay, keeping
 * the timeline contiguous throughout.
 */
function enforceDurationBounds(scenes: PlannedScene[], durationSec: number): PlannedScene[] {
  const merged: PlannedScene[] = [];

  for (const scene of scenes) {
    const previous = merged[merged.length - 1];
    const length = scene.endSec - scene.startSec;

    if (previous && length < LIMITS.minSceneDurationSec) {
      previous.endSec = scene.endSec;
      previous.words = [...previous.words, ...scene.words];
      previous.narration = `${previous.narration} ${scene.narration}`.trim();
      continue;
    }
    merged.push({ ...scene });
  }

  const split: PlannedScene[] = [];
  for (const scene of merged) {
    const length = scene.endSec - scene.startSec;
    if (length <= LIMITS.maxSceneDurationSec) {
      split.push(scene);
      continue;
    }

    // Long scene: cut it into equal parts on word boundaries, reusing the same
    // visual prompt with an escalating camera move so the shots differ.
    const parts = Math.ceil(length / LIMITS.maxSceneDurationSec);
    const wordsPerPart = Math.ceil(scene.words.length / parts);
    for (let p = 0; p < parts; p += 1) {
      const slice = scene.words.slice(p * wordsPerPart, (p + 1) * wordsPerPart);
      const start = p === 0 ? scene.startSec : (slice[0]?.start ?? scene.startSec + (length / parts) * p);
      const end =
        p === parts - 1 ? scene.endSec : (slice[slice.length - 1]?.end ?? start + length / parts);
      split.push({
        ...scene,
        narration: slice.length ? slice.map((w) => w.text).join(' ') : scene.narration,
        words: slice,
        startSec: start,
        endSec: end,
        cameraMotion: p % 2 === 0 ? scene.cameraMotion : alternateMotion(scene.cameraMotion),
      });
    }
  }

  return makeContiguous(
    split.map((scene, index) => ({ ...scene, index })),
    durationSec,
  );
}

/** Pick a contrasting move so split halves of one beat are not identical. */
function alternateMotion(motion: CameraMotion): CameraMotion {
  const pairs: Partial<Record<CameraMotion, CameraMotion>> = {
    push_in: 'pan_right',
    pull_out: 'tilt_up',
    zoom_in: 'orbit',
    zoom_out: 'dolly_in',
    pan_left: 'push_in',
    pan_right: 'pull_out',
    static: 'handheld',
  };
  return pairs[motion] ?? 'push_in';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
