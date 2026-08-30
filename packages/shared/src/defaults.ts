import type { CaptionStyle } from './enums';
import type { CaptionSettings, KeyPoolSettings, ProjectSettings } from './types';

/**
 * Caption presets. Each preset is a complete `CaptionSettings` minus the
 * fields the user is expected to override (keywords, emoji).
 */
export const CAPTION_PRESETS: Record<CaptionStyle, Omit<CaptionSettings, 'keywords' | 'emoji' | 'enabled'>> = {
  tiktok: {
    style: 'tiktok',
    mode: 'word',
    fontFamily: 'Montserrat ExtraBold',
    fontSize: 72,
    primaryColor: '#FFFFFF',
    highlightColor: '#00F5D4',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 6,
    shadowDepth: 3,
    position: 'center',
    marginVertical: 420,
    uppercase: true,
    animation: 'pop',
    maxWordsPerCue: 3,
  },
  reels: {
    style: 'reels',
    mode: 'karaoke',
    fontFamily: 'Poppins SemiBold',
    fontSize: 64,
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD60A',
    outlineColor: '#101010',
    shadowColor: '#000000',
    outlineWidth: 5,
    shadowDepth: 2,
    position: 'bottom',
    marginVertical: 320,
    uppercase: false,
    animation: 'fade',
    maxWordsPerCue: 4,
  },
  shorts: {
    style: 'shorts',
    mode: 'word',
    fontFamily: 'Inter Black',
    fontSize: 68,
    primaryColor: '#FFFFFF',
    highlightColor: '#FF375F',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 5,
    shadowDepth: 4,
    position: 'center',
    marginVertical: 380,
    uppercase: true,
    animation: 'slide-up',
    maxWordsPerCue: 3,
  },
  documentary: {
    style: 'documentary',
    mode: 'sentence',
    fontFamily: 'Source Sans Pro',
    fontSize: 44,
    primaryColor: '#F5F5F5',
    highlightColor: '#F5F5F5',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 2,
    shadowDepth: 1,
    position: 'bottom',
    marginVertical: 90,
    uppercase: false,
    animation: 'fade',
    maxWordsPerCue: 12,
  },
  cinematic: {
    style: 'cinematic',
    mode: 'sentence',
    fontFamily: 'Playfair Display',
    fontSize: 48,
    primaryColor: '#F8F5EF',
    highlightColor: '#E0C097',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 1,
    shadowDepth: 3,
    position: 'bottom',
    marginVertical: 140,
    uppercase: false,
    animation: 'fade',
    maxWordsPerCue: 10,
  },
  minimal: {
    style: 'minimal',
    mode: 'sentence',
    fontFamily: 'Inter',
    fontSize: 40,
    primaryColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outlineWidth: 0,
    shadowDepth: 1,
    position: 'bottom',
    marginVertical: 110,
    uppercase: false,
    animation: 'none',
    maxWordsPerCue: 8,
  },
};

export function captionPreset(style: CaptionStyle): CaptionSettings {
  return {
    ...CAPTION_PRESETS[style],
    enabled: true,
    emoji: style === 'tiktok' || style === 'reels' || style === 'shorts',
    keywords: [],
  };
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  caption: captionPreset('tiktok'),
  transition: {
    enabled: true,
    types: [],
    intensity: 0.5,
    durationSec: 0.4,
  },
  export: {
    format: 'mp4',
    resolution: '1080p',
    fps: 30,
    videoBitrateKbps: null,
    audioBitrateKbps: 192,
  },
  broll: {
    enabled: true,
    maxRatio: 0.35,
    categories: [
      'animals',
      'cars',
      'cities',
      'nature',
      'food',
      'sports',
      'buildings',
      'technology',
    ],
  },
  characterLock: true,
  styleLock: true,
  motionEnabled: true,
};

export const DEFAULT_KEY_POOL_SETTINGS: KeyPoolSettings = {
  strategy: 'failover',
  maxConcurrentPerKey: 4,
  cooldownSeconds: 60,
  maxRetries: 5,
};

/** Duration presets offered on the create-project screen, in seconds. */
export const DURATION_PRESETS = [30, 60, 180, 300, 600] as const;

/** Languages the transcription engine is tuned for. */
export const SUPPORTED_LANGUAGES = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'ur', label: 'Urdu' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'id', label: 'Indonesian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ru', label: 'Russian' },
  { code: 'bn', label: 'Bengali' },
  { code: 'fa', label: 'Persian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'mixed', label: 'Mixed-language narration' },
] as const;

/** Right-to-left languages need RTL-aware caption rendering. */
export const RTL_LANGUAGES = new Set(['ur', 'ar', 'fa', 'he']);

export const SUPPORTED_AUDIO_MIME = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/aac',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/flac',
  'audio/x-flac',
] as const;

export const SUPPORTED_IMAGE_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export const SUPPORTED_VIDEO_MIME = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;

export const LIMITS = {
  minStyleReferences: 2,
  maxStyleReferences: 20,
  maxCompetitorVideos: 5,
  maxScenesPerProject: 500,
  maxTranscriptWords: 100_000,
  maxAudioSeconds: 7200,
  maxAudioBytes: 1024 * 1024 * 1024,
  maxImageBytes: 32 * 1024 * 1024,
  maxVideoBytes: 2 * 1024 * 1024 * 1024,
  minSceneDurationSec: 1.2,
  maxSceneDurationSec: 12,
} as const;
