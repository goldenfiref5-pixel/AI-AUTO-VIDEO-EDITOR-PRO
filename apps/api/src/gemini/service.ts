import { env } from '../config/env';
import { logger } from '../config/logger';
import { query } from '../db/pool';
import { sleep } from '../utils/async';
import { parseJsonLoose } from '../utils/json';
import type { GeminiClient, RequestUsage } from './client';
import { runWithKey } from './keyPool';
import { GeminiError, type Content, type GenerationConfig, type Part } from './types';

export interface GenerationContext {
  userId: string;
  projectId?: string | null;
}

/** Persist a usage row so the admin dashboard can cost the pipeline. */
async function recordUsage(
  ctx: GenerationContext,
  kind: string,
  usage: Partial<RequestUsage> & { units?: number; model: string },
): Promise<void> {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const units = usage.units ?? 0;

  let costUsd =
    (inputTokens / 1_000_000) * env.COST_PER_MTOK_INPUT_USD +
    (outputTokens / 1_000_000) * env.COST_PER_MTOK_OUTPUT_USD;

  if (kind === 'image') costUsd += units * env.COST_PER_IMAGE_USD;
  if (kind === 'video') costUsd += units * env.COST_PER_CLIP_SECOND_USD;
  if (kind === 'transcription') costUsd += units * env.COST_PER_AUDIO_MINUTE_USD;

  await query(
    `INSERT INTO usage_events (user_id, project_id, kind, model, units, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      ctx.userId,
      ctx.projectId ?? null,
      kind,
      usage.model,
      units,
      inputTokens,
      outputTokens,
      costUsd.toFixed(6),
    ],
  ).catch((err) => logger.warn({ err }, 'Failed to record usage event'));
}

function textFromResponse(parts: Part[] | undefined): string {
  if (!parts) return '';
  return parts
    .map((p) => ('text' in p ? p.text : ''))
    .filter(Boolean)
    .join('')
    .trim();
}

export interface TextRequest {
  prompt: string | Part[];
  system?: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask for structured output; the response is parsed with the loose parser. */
  json?: boolean;
  responseSchema?: Record<string, unknown>;
  /** 0 disables Gemini 2.5 "thinking" for latency-sensitive calls. */
  thinkingBudget?: number;
  history?: Content[];
  timeoutMs?: number;
}

export async function generateText(ctx: GenerationContext, req: TextRequest): Promise<string> {
  const model = req.model ?? env.GEMINI_TEXT_MODEL;
  const parts: Part[] = typeof req.prompt === 'string' ? [{ text: req.prompt }] : req.prompt;

  const generationConfig: GenerationConfig = {
    temperature: req.temperature ?? 0.7,
    maxOutputTokens: req.maxOutputTokens ?? 8192,
  };
  if (req.json) generationConfig.responseMimeType = 'application/json';
  if (req.responseSchema) generationConfig.responseSchema = req.responseSchema;
  if (req.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget: req.thinkingBudget };
  }

  const { value } = await runWithKey(
    { userId: ctx.userId, model, label: 'generateText' },
    async (client) => {
      const { response, usage } = await client.generateContent(
        model,
        {
          contents: [...(req.history ?? []), { role: 'user', parts }],
          systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
          generationConfig,
        },
        req.timeoutMs,
      );

      const candidate = response.candidates?.[0];
      const text = textFromResponse(candidate?.content?.parts);

      if (!text) {
        const reason = candidate?.finishReason ?? 'no candidates';
        throw new GeminiError({
          message: `Gemini returned an empty response (${reason})`,
          failureClass: reason === 'SAFETY' ? 'safety' : 'unknown',
          retryable: reason !== 'SAFETY',
          keyAtFault: false,
          detail: candidate,
        });
      }

      await recordUsage(ctx, 'text', { ...usage, model });
      return text;
    },
  );

  return value;
}

export async function generateJson<T>(ctx: GenerationContext, req: TextRequest): Promise<T> {
  const raw = await generateText(ctx, { ...req, json: true, temperature: req.temperature ?? 0.4 });
  return parseJsonLoose<T>(raw);
}

export interface ImageRequest {
  prompt: string;
  /** Reference images that steer character/style consistency. */
  referenceImages?: Array<{ mimeType: string; data: Buffer }>;
  aspectRatio?: string;
  model?: string;
  temperature?: number;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  model: string;
}

export async function generateImage(
  ctx: GenerationContext,
  req: ImageRequest,
): Promise<GeneratedImage> {
  const model = req.model ?? env.GEMINI_IMAGE_MODEL;

  const parts: Part[] = [];
  // Reference images go first — the model conditions the generation on them.
  for (const ref of req.referenceImages ?? []) {
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data.toString('base64') } });
  }
  parts.push({ text: req.prompt });

  const { value } = await runWithKey(
    { userId: ctx.userId, model, label: 'generateImage' },
    async (client) => {
      const { response, usage } = await client.generateContent(model, {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          temperature: req.temperature ?? 0.85,
          imageConfig: req.aspectRatio ? { aspectRatio: req.aspectRatio } : undefined,
        },
      });

      const candidate = response.candidates?.[0];
      const imagePart = candidate?.content?.parts?.find(
        (p): p is { inlineData: { mimeType: string; data: string } } =>
          'inlineData' in p && Boolean(p.inlineData?.data),
      );

      if (!imagePart) {
        const reason = candidate?.finishReason ?? 'no image part';
        throw new GeminiError({
          message: `Image generation returned no image (${reason})`,
          failureClass: reason === 'SAFETY' || reason === 'IMAGE_SAFETY' ? 'safety' : 'unknown',
          retryable: reason !== 'SAFETY' && reason !== 'IMAGE_SAFETY',
          keyAtFault: false,
          detail: textFromResponse(candidate?.content?.parts).slice(0, 300),
        });
      }

      await recordUsage(ctx, 'image', { ...usage, model, units: 1 });

      return {
        data: Buffer.from(imagePart.inlineData.data, 'base64'),
        mimeType: imagePart.inlineData.mimeType || 'image/png',
        model,
      };
    },
  );

  return value;
}

export interface VideoRequest {
  prompt: string;
  /** Still frame the clip animates from. */
  image: { mimeType: string; data: Buffer };
  durationSec: number;
  aspectRatio: string;
  negativePrompt?: string;
  model?: string;
}

export interface GeneratedVideo {
  data: Buffer;
  mimeType: string;
  model: string;
}

/**
 * Image-to-video via Veo. The operation is long-running and must be polled on
 * the same API key that started it, so the poll loop runs inside `runWithKey`.
 */
export async function generateVideoClip(
  ctx: GenerationContext,
  req: VideoRequest,
): Promise<GeneratedVideo> {
  const model = req.model ?? env.GEMINI_VIDEO_MODEL;
  // Veo accepts a small set of discrete durations.
  const duration = Math.max(4, Math.min(8, Math.round(req.durationSec)));

  const { value } = await runWithKey(
    { userId: ctx.userId, model, label: 'generateVideoClip' },
    async (client: GeminiClient) => {
      const operation = await client.predictLongRunning(model, {
        instances: [
          {
            prompt: req.prompt,
            image: {
              bytesBase64Encoded: req.image.data.toString('base64'),
              mimeType: req.image.mimeType,
            },
          },
        ],
        parameters: {
          aspectRatio: req.aspectRatio,
          durationSeconds: duration,
          personGeneration: 'allow_all',
          ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
        },
      });

      const deadline = Date.now() + env.GEMINI_VIDEO_TIMEOUT_MS;
      let current = operation;

      while (!current.done) {
        if (Date.now() > deadline) {
          throw new GeminiError({
            message: `Video generation did not finish within ${env.GEMINI_VIDEO_TIMEOUT_MS}ms`,
            failureClass: 'timeout',
            retryable: true,
            keyAtFault: false,
          });
        }
        await sleep(env.GEMINI_VIDEO_POLL_INTERVAL_MS);
        current = await client.getOperation(current.name);
      }

      if (current.error) {
        throw new GeminiError({
          message: `Video generation failed: ${current.error.message}`,
          statusCode: current.error.code,
          failureClass: current.error.code === 429 ? 'quota' : 'bad_request',
          retryable: false,
          keyAtFault: current.error.code === 429,
          detail: current.error,
        });
      }

      const uri = extractVideoUri(current.response);
      const inline = extractInlineVideo(current.response);

      let data: Buffer;
      if (inline) {
        data = Buffer.from(inline, 'base64');
      } else if (uri) {
        data = await client.downloadUri(uri);
      } else {
        throw new GeminiError({
          message: 'Video operation completed without returning any media',
          failureClass: 'unknown',
          retryable: true,
          keyAtFault: false,
          detail: current.response,
        });
      }

      await recordUsage(ctx, 'video', { model, units: duration, latencyMs: 0, inputTokens: 0, outputTokens: 0 });
      return { data, mimeType: 'video/mp4', model };
    },
  );

  return value;
}

/** Veo responses nest the result differently across model revisions. */
function extractVideoUri(response: Record<string, unknown> | undefined): string | null {
  if (!response) return null;
  const paths: Array<unknown> = [
    (response as any)?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri,
    (response as any)?.generatedVideos?.[0]?.video?.uri,
    (response as any)?.predictions?.[0]?.videoUri,
    (response as any)?.videos?.[0]?.uri,
  ];
  for (const candidate of paths) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

function extractInlineVideo(response: Record<string, unknown> | undefined): string | null {
  if (!response) return null;
  const paths: Array<unknown> = [
    (response as any)?.predictions?.[0]?.bytesBase64Encoded,
    (response as any)?.generatedVideos?.[0]?.video?.bytesBase64Encoded,
    (response as any)?.generateVideoResponse?.generatedSamples?.[0]?.video?.bytesBase64Encoded,
  ];
  for (const candidate of paths) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

export interface AudioAnalysisRequest {
  filePath: string;
  mimeType: string;
  displayName: string;
  prompt: string;
  system?: string;
  model?: string;
  maxOutputTokens?: number;
  durationSec?: number;
}

/**
 * Upload media through the Files API and run a single generateContent over it.
 * Used by transcription (audio) and competitor analysis (video).
 */
export async function analyzeMedia(
  ctx: GenerationContext,
  req: AudioAnalysisRequest,
  kind: 'transcription' | 'video_analysis',
): Promise<string> {
  const model = req.model ?? env.GEMINI_TRANSCRIBE_MODEL;

  const { value } = await runWithKey(
    { userId: ctx.userId, model, label: `analyzeMedia:${kind}` },
    async (client) => {
      const uploaded = await client.uploadFile({
        filePath: req.filePath,
        mimeType: req.mimeType,
        displayName: req.displayName,
      });
      const ready = await client.waitForFileActive(uploaded.name);

      try {
        const { response, usage } = await client.generateContent(model, {
          contents: [
            {
              role: 'user',
              parts: [
                { fileData: { fileUri: ready.uri, mimeType: ready.mimeType } },
                { text: req.prompt },
              ],
            },
          ],
          systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: req.maxOutputTokens ?? env.GEMINI_MAX_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
          },
        });

        const text = textFromResponse(response.candidates?.[0]?.content?.parts);
        if (!text) {
          throw new GeminiError({
            message: `Media analysis returned nothing (${response.candidates?.[0]?.finishReason ?? 'unknown'})`,
            failureClass: 'unknown',
            retryable: true,
            keyAtFault: false,
          });
        }

        await recordUsage(ctx, kind === 'transcription' ? 'transcription' : 'text', {
          ...usage,
          model,
          units: kind === 'transcription' ? (req.durationSec ?? 0) / 60 : 0,
        });

        return text;
      } finally {
        // Files expire after 48h anyway, but reclaiming quota immediately is
        // cheap and keeps the user's file list clean.
        void client.deleteFile(ready.name);
      }
    },
  );

  return value;
}

export interface ImageAnalysisRequest {
  images: Array<{ mimeType: string; data: Buffer }>;
  prompt: string;
  system?: string;
  model?: string;
}

export async function analyzeImages(
  ctx: GenerationContext,
  req: ImageAnalysisRequest,
): Promise<string> {
  const parts: Part[] = req.images.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.data.toString('base64') },
  }));
  parts.push({ text: req.prompt });

  return generateText(ctx, {
    prompt: parts,
    system: req.system,
    model: req.model ?? env.GEMINI_REASONING_MODEL,
    json: true,
    temperature: 0.2,
    maxOutputTokens: 16_384,
  });
}
