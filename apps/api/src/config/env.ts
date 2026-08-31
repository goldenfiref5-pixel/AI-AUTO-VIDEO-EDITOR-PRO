import 'dotenv/config';
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

/**
 * Treats an empty string as absent, so a blank docker-compose passthrough falls
 * back to the default instead of failing validation and crash-looping the
 * container.
 */
const numeric = (fallback: number) =>
  z.preprocess(
    (v) => (v === undefined || v === null || String(v).trim() === '' ? fallback : v),
    z.coerce.number().int(),
  );

/** Treats an empty string as absent, so a blank passthrough uses the default. */
const model = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : v.trim()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/aiedit'),
  DATABASE_SSL: bool(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(16).default('dev-only-insecure-jwt-secret-change-me'),
  JWT_ACCESS_TTL: z.string().default('1h'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  /** 32-byte key, hex or base64, used for AES-256-GCM at-rest encryption. */
  ENCRYPTION_KEY: z.string().default(''),

  GOOGLE_CLIENT_ID: z.string().default(''),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool(true),
  S3_PUBLIC_BASE_URL: z.string().default(''),

  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  RENDER_TMP_DIR: z.string().default('./tmp/renders'),
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  GENERATION_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  ANALYSIS_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),

  GEMINI_API_BASE: z.string().url().default('https://generativelanguage.googleapis.com'),
  // Google retires model ids, and a newly created key is often not offered an
  // older one at all. `model()` treats an empty value as unset so a blank
  // passthrough in docker-compose falls back to the default here.
  // Verified against a live key's model list. Note that listModels returns
  // models generateContent will still refuse - the 2.5 family is listed but
  // rejected for keys created recently - so none of those are used here.
  GEMINI_TEXT_MODEL: model('gemini-3.6-flash'),
  // No 3.6 pro exists; the alias tracks whatever the current pro model is.
  GEMINI_REASONING_MODEL: model('gemini-pro-latest'),
  GEMINI_IMAGE_MODEL: model('gemini-3.1-flash-image'),
  GEMINI_VIDEO_MODEL: model('veo-3.1-generate-preview'),
  GEMINI_TRANSCRIBE_MODEL: model('gemini-3.6-flash'),
  // Output ceiling for the long-form calls. Asking for more than a model
  // allows is rejected as INVALID_ARGUMENT, and the limit varies per model, so
  // this stays conservative and tunable rather than assuming a large budget.
  GEMINI_MAX_OUTPUT_TOKENS: numeric(32_768),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(1_800_000).default(180_000),
  GEMINI_VIDEO_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  GEMINI_VIDEO_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(900_000),

  /** Fallback key used when a user has no keys of their own. */
  GEMINI_FALLBACK_API_KEY: z.string().default(''),

  UPLOAD_TMP_DIR: z.string().default('./tmp/uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(2 * 1024 * 1024 * 1024),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),

  /** Cost model used for the admin dashboard's spend estimates (USD). */
  COST_PER_IMAGE_USD: z.coerce.number().min(0).default(0.039),
  COST_PER_CLIP_SECOND_USD: z.coerce.number().min(0).default(0.35),
  COST_PER_AUDIO_MINUTE_USD: z.coerce.number().min(0).default(0.006),
  COST_PER_MTOK_INPUT_USD: z.coerce.number().min(0).default(0.3),
  COST_PER_MTOK_OUTPUT_USD: z.coerce.number().min(0).default(2.5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (isProduction) {
  const problems: string[] = [];
  if (env.JWT_SECRET.startsWith('dev-only')) problems.push('JWT_SECRET must be set to a strong secret');
  if (!env.ENCRYPTION_KEY) problems.push('ENCRYPTION_KEY must be set (32 bytes, hex or base64)');
  if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) problems.push('S3_BUCKET is required when STORAGE_DRIVER=s3');
  if (problems.length) {
    throw new Error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}
