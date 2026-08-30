import { z } from 'zod';
import {
  ASPECT_RATIOS,
  CAMERA_MOTIONS,
  CAPTION_ANIMATIONS,
  CAPTION_MODES,
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  EXPORT_FORMATS,
  EXPORT_RESOLUTIONS,
  FRAME_RATES,
  KEY_STRATEGIES,
  TEMPLATE_KINDS,
  TRANSITIONS,
} from './enums';

const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Expected a hex colour');

export const captionSettingsSchema = z.object({
  enabled: z.boolean(),
  style: z.enum(CAPTION_STYLES),
  mode: z.enum(CAPTION_MODES),
  fontFamily: z.string().min(1).max(64),
  fontSize: z.number().int().min(8).max(200),
  primaryColor: hexColor,
  highlightColor: hexColor,
  outlineColor: hexColor,
  shadowColor: hexColor,
  outlineWidth: z.number().min(0).max(20),
  shadowDepth: z.number().min(0).max(20),
  position: z.enum(CAPTION_POSITIONS),
  marginVertical: z.number().int().min(0).max(1000),
  uppercase: z.boolean(),
  animation: z.enum(CAPTION_ANIMATIONS),
  emoji: z.boolean(),
  keywords: z.array(z.string().min(1).max(48)).max(200),
  maxWordsPerCue: z.number().int().min(1).max(24),
});

export const transitionSettingsSchema = z.object({
  enabled: z.boolean(),
  types: z.array(z.enum(TRANSITIONS)).max(TRANSITIONS.length),
  intensity: z.number().min(0).max(1),
  durationSec: z.number().min(0.05).max(3),
});

export const exportSettingsSchema = z.object({
  format: z.enum(EXPORT_FORMATS),
  resolution: z.enum(EXPORT_RESOLUTIONS),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
  videoBitrateKbps: z.number().int().min(500).max(200_000).nullable(),
  audioBitrateKbps: z.number().int().min(64).max(512),
});

export const brollSettingsSchema = z.object({
  enabled: z.boolean(),
  maxRatio: z.number().min(0).max(1),
  categories: z.array(z.string().min(1).max(40)).max(40),
});

export const projectSettingsSchema = z.object({
  caption: captionSettingsSchema,
  transition: transitionSettingsSchema,
  export: exportSettingsSchema,
  broll: brollSettingsSchema,
  characterLock: z.boolean(),
  styleLock: z.boolean(),
  motionEnabled: z.boolean(),
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(160),
  videoTitle: z.string().max(240).optional().nullable(),
  aspectRatio: z.enum(ASPECT_RATIOS),
  /** 0/undefined means "follow the voiceover length exactly". */
  targetDurationSec: z.number().int().min(5).max(7200).optional().nullable(),
  language: z.string().min(2).max(16).default('en'),
  settings: projectSettingsSchema.partial().optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  videoTitle: z.string().max(240).nullable().optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  targetDurationSec: z.number().int().min(5).max(7200).nullable().optional(),
  language: z.string().min(2).max(16).optional(),
  settings: projectSettingsSchema.deepPartial().optional(),
});

export const transcriptWordSchema = z.object({
  text: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  confidence: z.number().min(0).max(1).optional(),
});

export const transcriptSegmentSchema = z.object({
  id: z.string(),
  index: z.number().int().min(0),
  text: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  speaker: z.string().nullable(),
  words: z.array(transcriptWordSchema),
});

export const updateTranscriptSchema = z.object({
  /** Either a full-text rewrite (re-aligned server side) or explicit segments. */
  text: z.string().max(2_000_000).optional(),
  segments: z.array(transcriptSegmentSchema).max(20_000).optional(),
  language: z.string().min(2).max(16).optional(),
});

export const enhanceTranscriptSchema = z.object({
  instructions: z.string().max(2000).optional(),
  fixGrammar: z.boolean().default(true),
  improvePunctuation: z.boolean().default(true),
  improveReadability: z.boolean().default(true),
});

export const searchReplaceSchema = z.object({
  search: z.string().min(1),
  replace: z.string(),
  caseSensitive: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
});

export const sceneUpdateSchema = z.object({
  narration: z.string().max(8000).optional(),
  visualPrompt: z.string().max(8000).optional(),
  negativePrompt: z.string().max(2000).nullable().optional(),
  emotion: z.string().max(120).optional(),
  location: z.string().max(240).optional(),
  characterIds: z.array(z.string().uuid()).max(24).optional(),
  cameraMotion: z.enum(CAMERA_MOTIONS).optional(),
  motionPrompt: z.string().max(2000).nullable().optional(),
  transitionIn: z.enum(TRANSITIONS).nullable().optional(),
  startSec: z.number().min(0).optional(),
  endSec: z.number().min(0).optional(),
  isBroll: z.boolean().optional(),
  brollSubject: z.string().max(240).nullable().optional(),
});

export const splitSceneSchema = z.object({
  /** Absolute timeline position, must fall strictly inside the scene. */
  atSec: z.number().min(0),
});

export const reorderScenesSchema = z.object({
  sceneIds: z.array(z.string().uuid()).min(1).max(2000),
});

export const characterUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.string().max(160).optional(),
  age: z.string().max(60).optional(),
  gender: z.string().max(60).optional(),
  skinTone: z.string().max(120).optional(),
  hair: z.string().max(240).optional(),
  face: z.string().max(480).optional(),
  bodyShape: z.string().max(240).optional(),
  clothing: z.string().max(480).optional(),
  accessories: z.string().max(240).optional(),
  canonicalPrompt: z.string().max(4000).optional(),
  locked: z.boolean().optional(),
});

export const styleDnaUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  summary: z.string().max(4000).optional(),
  colorPalette: z.array(hexColor).max(24).optional(),
  colorGrading: z.string().max(600).optional(),
  lighting: z.string().max(600).optional(),
  composition: z.string().max(600).optional(),
  cameraLens: z.string().max(240).optional(),
  cameraStyle: z.string().max(600).optional(),
  mood: z.string().max(240).optional(),
  realismLevel: z.string().max(240).optional(),
  artisticStyle: z.string().max(600).optional(),
  negativePrompt: z.string().max(2000).optional(),
  locked: z.boolean().optional(),
});

export const competitorUrlSchema = z.object({
  url: z.string().url().max(2048),
});

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(120),
  key: z.string().min(20).max(400),
  priority: z.number().int().min(0).max(9999).optional(),
  enabled: z.boolean().optional(),
});

export const updateApiKeySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
});

export const reorderApiKeysSchema = z.object({
  keyIds: z.array(z.string().uuid()).min(1).max(500),
});

export const keyPoolSettingsSchema = z.object({
  strategy: z.enum(KEY_STRATEGIES),
  maxConcurrentPerKey: z.number().int().min(1).max(64),
  cooldownSeconds: z.number().int().min(5).max(3600),
  maxRetries: z.number().int().min(1).max(20),
});

export const renderRequestSchema = z.object({
  format: z.enum(EXPORT_FORMATS).optional(),
  resolution: z.enum(EXPORT_RESOLUTIONS).optional(),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

export const generateRequestSchema = z.object({
  /** Regenerate these scenes only; empty/omitted means the whole project. */
  sceneIds: z.array(z.string().uuid()).max(2000).optional(),
  force: z.boolean().default(false),
  priority: z.number().int().min(0).max(100).optional(),
});

export const templateSchema = z.object({
  kind: z.enum(TEMPLATE_KINDS),
  name: z.string().min(1).max(160),
  description: z.string().max(1000).nullable().optional(),
  payload: z.record(z.unknown()),
});

export const batchGenerateSchema = z.object({
  projectIds: z.array(z.string().uuid()).min(1).max(50),
  priority: z.number().int().min(0).max(100).optional(),
});

export const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(200),
  name: z.string().min(1).max(160).optional(),
});

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const googleLoginSchema = z.object({
  idToken: z.string().min(20).max(8000),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type UpdateTranscriptInput = z.infer<typeof updateTranscriptSchema>;
export type SceneUpdateInput = z.infer<typeof sceneUpdateSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type RenderRequestInput = z.infer<typeof renderRequestSchema>;
export type GenerateRequestInput = z.infer<typeof generateRequestSchema>;
