import type {
  ApiKeyRecord,
  Asset,
  CharacterProfile,
  CompetitorInsight,
  Job,
  Project,
  ProjectSettings,
  QualityReport,
  RenderRecord,
  Scene,
  StyleDna,
  Template,
  Transcript,
  User,
} from '@aiedit/shared';
import { DEFAULT_PROJECT_SETTINGS } from '@aiedit/shared';
import { deepMerge } from '../utils/json';

type Row = Record<string, unknown>;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : new Date(0).toISOString();

const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);

const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);

const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/** `jsonb` comes back parsed from `pg`, but tolerate a string just in case. */
function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function mapUser(row: Row): User {
  return {
    id: str(row['id']),
    email: str(row['email']),
    name: strOrNull(row['name']),
    avatarUrl: strOrNull(row['avatar_url']),
    role: str(row['role'], 'user') as User['role'],
    createdAt: iso(row['created_at']),
  };
}

export function mapProject(row: Row): Project {
  return {
    id: str(row['id']),
    userId: str(row['user_id']),
    name: str(row['name']),
    videoTitle: strOrNull(row['video_title']),
    aspectRatio: str(row['aspect_ratio'], '9:16') as Project['aspectRatio'],
    targetDurationSec: numOrNull(row['target_duration_sec']),
    language: str(row['language'], 'en'),
    status: str(row['status'], 'draft') as Project['status'],
    progress: num(row['progress']),
    // Settings are stored as a partial patch over the defaults, so adding a new
    // setting does not require backfilling every existing project.
    settings: deepMerge<ProjectSettings>(
      DEFAULT_PROJECT_SETTINGS,
      json<Partial<ProjectSettings>>(row['settings'], {}),
    ),
    qualityReport: json<QualityReport | null>(row['quality_report'], null),
    errorMessage: strOrNull(row['error_message']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

export function mapAsset(row: Row): Asset {
  return {
    id: str(row['id']),
    projectId: strOrNull(row['project_id']),
    userId: str(row['user_id']),
    kind: str(row['kind']) as Asset['kind'],
    storageKey: str(row['storage_key']),
    filename: str(row['filename']),
    mimeType: str(row['mime_type']),
    bytes: num(row['bytes']),
    durationSec: numOrNull(row['duration_sec']),
    width: numOrNull(row['width']),
    height: numOrNull(row['height']),
    metadata: json<Record<string, unknown>>(row['metadata'], {}),
    createdAt: iso(row['created_at']),
  };
}

export function mapTranscript(row: Row): Transcript {
  return {
    id: str(row['id']),
    projectId: str(row['project_id']),
    assetId: str(row['asset_id']),
    language: str(row['language'], 'en'),
    text: str(row['text']),
    segments: json<Transcript['segments']>(row['segments'], []),
    wordCount: num(row['word_count']),
    durationSec: num(row['duration_sec']),
    confidence: num(row['confidence']),
    approvedAt: isoOrNull(row['approved_at']),
    version: num(row['version'], 1),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

export function mapStyleDna(row: Row): StyleDna {
  return {
    id: str(row['id']),
    projectId: str(row['project_id']),
    name: str(row['name'], 'Style DNA'),
    summary: str(row['summary']),
    colorPalette: json<string[]>(row['color_palette'], []),
    colorGrading: str(row['color_grading']),
    lighting: str(row['lighting']),
    composition: str(row['composition']),
    cameraLens: str(row['camera_lens']),
    cameraStyle: str(row['camera_style']),
    mood: str(row['mood']),
    realismLevel: str(row['realism_level']),
    artisticStyle: str(row['artistic_style']),
    textureDetail: str(row['texture_detail']),
    negativePrompt: str(row['negative_prompt']),
    promptSuffix: str(row['prompt_suffix']),
    sourceAssetIds: json<string[]>(row['source_asset_ids'], []),
    locked: Boolean(row['locked']),
    createdAt: iso(row['created_at']),
  };
}

export function mapCompetitorInsight(row: Row): CompetitorInsight {
  return {
    id: str(row['id']),
    projectId: str(row['project_id']),
    assetId: strOrNull(row['asset_id']),
    sourceUrl: strOrNull(row['source_url']),
    editingPace: str(row['editing_pace']),
    avgSceneDurationSec: num(row['avg_scene_duration_sec']),
    storyStructure: str(row['story_structure']),
    captionStyle: str(row['caption_style']),
    transitionStyle: str(row['transition_style']),
    cameraMovement: str(row['camera_movement']),
    hookStructure: str(row['hook_structure']),
    visualRhythm: str(row['visual_rhythm']),
    sceneDurationPattern: json<number[]>(row['scene_duration_pattern'], []),
    recommendations: json<string[]>(row['recommendations'], []),
    createdAt: iso(row['created_at']),
  };
}

export function mapCharacter(row: Row): CharacterProfile {
  return {
    id: str(row['id']),
    projectId: str(row['project_id']),
    name: str(row['name']),
    role: str(row['role']),
    age: str(row['age']),
    gender: str(row['gender']),
    skinTone: str(row['skin_tone']),
    hair: str(row['hair']),
    face: str(row['face']),
    bodyShape: str(row['body_shape']),
    clothing: str(row['clothing']),
    accessories: str(row['accessories']),
    voiceTone: str(row['voice_tone']),
    canonicalPrompt: str(row['canonical_prompt']),
    referenceAssetId: strOrNull(row['reference_asset_id']),
    locked: Boolean(row['locked']),
    createdAt: iso(row['created_at']),
  };
}

export function mapScene(row: Row): Scene {
  return {
    id: str(row['id']),
    projectId: str(row['project_id']),
    index: num(row['scene_index']),
    startSec: num(row['start_sec']),
    endSec: num(row['end_sec']),
    narration: str(row['narration']),
    visualPrompt: str(row['visual_prompt']),
    negativePrompt: strOrNull(row['negative_prompt']),
    emotion: str(row['emotion']),
    location: str(row['location']),
    characterIds: json<string[]>(row['character_ids'], []),
    cameraMotion: str(row['camera_motion'], 'push_in') as Scene['cameraMotion'],
    motionPrompt: strOrNull(row['motion_prompt']),
    transitionIn: strOrNull(row['transition_in']) as Scene['transitionIn'],
    isBroll: Boolean(row['is_broll']),
    brollSubject: strOrNull(row['broll_subject']),
    status: str(row['status'], 'planned') as Scene['status'],
    imageAssetId: strOrNull(row['image_asset_id']),
    clipAssetId: strOrNull(row['clip_asset_id']),
    words: json<Scene['words']>(row['words'], []),
    attempts: num(row['attempts']),
    errorMessage: strOrNull(row['error_message']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

export function mapJob(row: Row): Job {
  return {
    id: str(row['id']),
    projectId: str(row['project_id']),
    userId: str(row['user_id']),
    type: str(row['type']) as Job['type'],
    status: str(row['status'], 'pending') as Job['status'],
    progress: num(row['progress']),
    total: num(row['total']),
    completed: num(row['completed']),
    failed: num(row['failed']),
    priority: num(row['priority'], 10),
    attempts: num(row['attempts']),
    message: strOrNull(row['message']),
    errorMessage: strOrNull(row['error_message']),
    payload: json<Record<string, unknown>>(row['payload'], {}),
    startedAt: isoOrNull(row['started_at']),
    finishedAt: isoOrNull(row['finished_at']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

export function mapRender(row: Row): RenderRecord {
  return {
    id: str(row['id']),
    projectId: str(row['project_id']),
    jobId: strOrNull(row['job_id']),
    format: str(row['format'], 'mp4') as RenderRecord['format'],
    resolution: str(row['resolution'], '1080p') as RenderRecord['resolution'],
    fps: num(row['fps'], 30) as RenderRecord['fps'],
    status: str(row['status'], 'pending') as RenderRecord['status'],
    assetId: strOrNull(row['asset_id']),
    downloadUrl: null,
    bytes: numOrNull(row['bytes']),
    durationSec: numOrNull(row['duration_sec']),
    qualityReport: json<QualityReport | null>(row['quality_report'], null),
    createdAt: iso(row['created_at']),
    finishedAt: isoOrNull(row['finished_at']),
  };
}

export function mapApiKey(row: Row): ApiKeyRecord {
  return {
    id: str(row['id']),
    userId: str(row['user_id']),
    name: str(row['name']),
    maskedKey: str(row['masked_key']),
    enabled: Boolean(row['enabled']),
    priority: num(row['priority']),
    status: str(row['status'], 'untested') as ApiKeyRecord['status'],
    lastTestedAt: isoOrNull(row['last_tested_at']),
    lastUsedAt: isoOrNull(row['last_used_at']),
    responseTimeMs: numOrNull(row['response_time_ms']),
    availableModels: json<string[]>(row['available_models'], []),
    requestCount: num(row['request_count']),
    failureCount: num(row['failure_count']),
    cooldownUntil: isoOrNull(row['cooldown_until']),
    statusMessage: strOrNull(row['status_message']),
    createdAt: iso(row['created_at']),
  };
}

export function mapTemplate(row: Row): Template {
  return {
    id: str(row['id']),
    userId: str(row['user_id']),
    kind: str(row['kind']) as Template['kind'],
    name: str(row['name']),
    description: strOrNull(row['description']),
    payload: json<Record<string, unknown>>(row['payload'], {}),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}
