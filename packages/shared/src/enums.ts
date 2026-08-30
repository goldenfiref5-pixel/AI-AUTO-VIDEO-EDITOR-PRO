/**
 * Enumerations shared between the API, the workers and the web client.
 * Every value here is persisted verbatim in PostgreSQL, so renaming a member
 * is a breaking change that requires a migration.
 */

export const ASPECT_RATIOS = ['9:16', '16:9', '1:1'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const PROJECT_STATUSES = [
  'draft',
  'transcribing',
  'transcript_ready',
  'analyzing',
  'storyboard_ready',
  'generating',
  'rendering',
  'completed',
  'failed',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const JOB_STATUSES = [
  'pending',
  'processing',
  'generating_images',
  'generating_video',
  'rendering',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = [
  'transcribe',
  'analyze_references',
  'story_analysis',
  'generate_images',
  'generate_clips',
  'render',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const ASSET_KINDS = [
  'voiceover',
  'style_reference',
  'competitor_video',
  'scene_image',
  'scene_clip',
  'broll_image',
  'broll_clip',
  'character_sheet',
  'render_output',
  'thumbnail',
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const CAPTION_STYLES = [
  'tiktok',
  'reels',
  'shorts',
  'documentary',
  'cinematic',
  'minimal',
] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export const CAPTION_MODES = ['word', 'sentence', 'karaoke'] as const;
export type CaptionMode = (typeof CAPTION_MODES)[number];

export const CAPTION_POSITIONS = ['top', 'center', 'bottom'] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];

export const CAPTION_ANIMATIONS = ['none', 'fade', 'pop', 'slide-up', 'typewriter'] as const;
export type CaptionAnimation = (typeof CAPTION_ANIMATIONS)[number];

export const TRANSITIONS = [
  'fade',
  'zoom',
  'blur',
  'motion_cut',
  'dynamic_swipe',
  'match_cut',
  'speed_ramp',
  'cinematic',
] as const;
export type TransitionType = (typeof TRANSITIONS)[number];

export const CAMERA_MOTIONS = [
  'static',
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
  'dolly_in',
  'dolly_out',
  'zoom_in',
  'zoom_out',
  'orbit',
  'push_in',
  'pull_out',
  'handheld',
] as const;
export type CameraMotion = (typeof CAMERA_MOTIONS)[number];

export const EXPORT_FORMATS = ['mp4', 'mov', 'webm'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_RESOLUTIONS = ['720p', '1080p', '1440p', '4k'] as const;
export type ExportResolution = (typeof EXPORT_RESOLUTIONS)[number];

export const FRAME_RATES = [24, 30, 60] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export const IMAGE_RESOLUTIONS = ['1024x1024', '1280x720', '1920x1080', '1080x1920'] as const;
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];

export const API_KEY_STATUSES = [
  'untested',
  'valid',
  'invalid',
  'expired',
  'blocked',
  'quota_exceeded',
  'rate_limited',
  'error',
] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

export const KEY_STRATEGIES = ['failover', 'load_balance'] as const;
export type KeyStrategy = (typeof KEY_STRATEGIES)[number];

export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const SCENE_STATUSES = [
  'planned',
  'image_queued',
  'image_ready',
  'clip_queued',
  'clip_ready',
  'failed',
] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

export const TEMPLATE_KINDS = [
  'style_dna',
  'character',
  'caption_preset',
  'export_preset',
  'video_template',
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
