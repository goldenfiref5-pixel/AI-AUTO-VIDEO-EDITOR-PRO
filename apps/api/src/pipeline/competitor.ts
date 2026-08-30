import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CompetitorInsight } from '@aiedit/shared';
import { logger } from '../config/logger';
import { analyzeMedia } from '../gemini/service';
import { asArray, asNumber, asString, parseJsonLoose } from '../utils/json';
import { compressForAnalysis, probeMedia } from '../render/ffmpeg';
import { COMPETITOR_PROMPT, COMPETITOR_SYSTEM } from './prompts';

export type CompetitorDraft = Omit<CompetitorInsight, 'id' | 'projectId' | 'createdAt'>;

/**
 * Learn the editorial grammar of a reference video: pacing, structure, caption
 * and transition vocabulary. Content is never copied — only technique is
 * extracted, and the prompt says so explicitly.
 */
export async function analyzeCompetitorVideo(params: {
  userId: string;
  projectId: string;
  assetId: string | null;
  sourceUrl: string | null;
  videoPath: string;
}): Promise<CompetitorDraft> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'aiedit-comp-'));
  try {
    const info = await probeMedia(params.videoPath);
    if (!info.hasVideo) throw new Error('The reference file contains no video stream.');

    // Analysis only needs the visual grammar, so the upload is downscaled to
    // 480p/8fps and capped at three minutes.
    const compressed = await compressForAnalysis(
      params.videoPath,
      path.join(workDir, 'analysis.mp4'),
      180,
    );

    const raw = await analyzeMedia(
      { userId: params.userId, projectId: params.projectId },
      {
        filePath: compressed,
        mimeType: 'video/mp4',
        displayName: 'competitor-reference',
        prompt: COMPETITOR_PROMPT,
        system: COMPETITOR_SYSTEM,
        maxOutputTokens: 8192,
      },
      'video_analysis',
    );

    const parsed = parseJsonLoose<Record<string, unknown>>(raw);

    const pattern = asArray<unknown>(parsed['sceneDurationPattern'])
      .map((v) => asNumber(v, 0))
      .filter((v) => v > 0 && v < 120)
      .slice(0, 40);

    const avg =
      asNumber(parsed['avgSceneDurationSec'], 0) ||
      (pattern.length ? pattern.reduce((a, b) => a + b, 0) / pattern.length : 3.2);

    return {
      assetId: params.assetId,
      sourceUrl: params.sourceUrl,
      editingPace: asString(parsed['editingPace'], 'moderate').slice(0, 400),
      avgSceneDurationSec: Number(avg.toFixed(3)),
      storyStructure: asString(parsed['storyStructure']).slice(0, 2000),
      captionStyle: asString(parsed['captionStyle']).slice(0, 1000),
      transitionStyle: asString(parsed['transitionStyle']).slice(0, 1000),
      cameraMovement: asString(parsed['cameraMovement']).slice(0, 1000),
      hookStructure: asString(parsed['hookStructure']).slice(0, 1000),
      visualRhythm: asString(parsed['visualRhythm']).slice(0, 1000),
      sceneDurationPattern: pattern,
      recommendations: asArray<unknown>(parsed['recommendations'])
        .map((r) => asString(r).slice(0, 400))
        .filter(Boolean)
        .slice(0, 12),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface PacingProfile {
  /** Mean shot length the story planner should aim for. */
  avgSceneDurationSec: number;
  label: 'very fast' | 'fast' | 'moderate' | 'slow';
  guidance: string;
  hookGuidance: string;
}

/**
 * Fold every competitor insight into one pacing target used by the story
 * planner. With no references we fall back to a sensible short-form rhythm.
 */
export function derivePacingProfile(
  insights: readonly Pick<
    CompetitorInsight,
    'avgSceneDurationSec' | 'editingPace' | 'hookStructure' | 'visualRhythm' | 'transitionStyle'
  >[],
  fallbackSceneSec = 4,
): PacingProfile {
  if (insights.length === 0) {
    return {
      avgSceneDurationSec: fallbackSceneSec,
      label: 'moderate',
      guidance:
        'Aim for a steady short-form rhythm: cut on sentence boundaries, keep shots around 4 seconds, and open on the strongest image in the script.',
      hookGuidance: 'Lead with the single most visually arresting moment in the first sentence.',
    };
  }

  const durations = insights.map((i) => i.avgSceneDurationSec).filter((d) => d > 0.4 && d < 30);
  const avg = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : fallbackSceneSec;

  const label: PacingProfile['label'] =
    avg < 1.8 ? 'very fast' : avg < 3 ? 'fast' : avg < 6 ? 'moderate' : 'slow';

  const rhythms = insights.map((i) => i.visualRhythm).filter(Boolean).slice(0, 3);
  const hooks = insights.map((i) => i.hookStructure).filter(Boolean).slice(0, 2);

  logger.debug({ avg, label }, 'Derived pacing profile from competitor references');

  return {
    avgSceneDurationSec: Number(avg.toFixed(2)),
    label,
    guidance: [
      `Reference videos cut at a ${label} pace, averaging ${avg.toFixed(1)}s per shot — match that rhythm.`,
      ...rhythms.map((r) => `Rhythm observed: ${r}`),
    ].join(' '),
    hookGuidance:
      hooks.length > 0
        ? `Apply this hook structure with entirely original content: ${hooks.join(' ')}`
        : 'Open on the strongest image available in the first sentence of narration.',
  };
}
