import type {
  CharacterProfile,
  Project,
  QualityMetric,
  QualityReport,
  Scene,
  StyleDna,
  Transcript,
} from '@aiedit/shared';
import { logger } from '../config/logger';
import { generateJson } from '../gemini/service';
import { asArray, asNumber, asString } from '../utils/json';
import { QUALITY_REVIEW_SYSTEM, qualityReviewPrompt } from '../pipeline/prompts';

export interface QualityInput {
  project: Project;
  transcript: Transcript;
  scenes: Scene[];
  characters: CharacterProfile[];
  styleDna: StyleDna | null;
  /** Set once the render finished, so timing can be scored against reality. */
  renderedDurationSec?: number | null;
  /** Cuts downgraded to hard cuts at a batch boundary during rendering. */
  downgradedTransitions?: number;
}

/**
 * Score a project before export.
 *
 * Most metrics are computed deterministically from the project's own data —
 * they are cheap, reproducible and cannot hallucinate. Story alignment and
 * visual quality are the two that genuinely need a model, and a failure there
 * degrades to a neutral score rather than blocking the export.
 */
export async function scoreProject(input: QualityInput): Promise<QualityReport> {
  const warnings: string[] = [];
  const metrics: QualityMetric[] = [];

  metrics.push(scoreCharacterConsistency(input, warnings));
  metrics.push(scoreStyleConsistency(input, warnings));
  metrics.push(scoreVisualCoverage(input, warnings));
  metrics.push(scoreTimingAccuracy(input, warnings));
  metrics.push(scoreCaptionQuality(input, warnings));

  const model = await scoreWithModel(input).catch((err) => {
    logger.warn({ err, projectId: input.project.id }, 'Model quality review failed');
    return null;
  });

  if (model) {
    metrics.push(model.storyAlignment, model.visualQuality);
    warnings.push(...model.warnings);
  } else {
    metrics.push({
      key: 'story_alignment',
      label: 'Story alignment',
      score: 75,
      weight: 0.2,
      notes: 'Automated review was unavailable; scored neutrally.',
    });
  }

  if (input.downgradedTransitions && input.downgradedTransitions > 0) {
    warnings.push(
      `${input.downgradedTransitions} transition${
        input.downgradedTransitions === 1 ? '' : 's'
      } fell on a render segment boundary and were rendered as hard cuts.`,
    );
  }

  const totalWeight = metrics.reduce((sum, m) => sum + m.weight, 0) || 1;
  const overall = Math.round(
    metrics.reduce((sum, m) => sum + m.score * m.weight, 0) / totalWeight,
  );

  return {
    overall,
    grade: gradeFor(overall),
    metrics,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

function scoreCharacterConsistency(input: QualityInput, warnings: string[]): QualityMetric {
  const withCharacters = input.scenes.filter((s) => s.characterIds.length > 0);
  if (withCharacters.length === 0) {
    return {
      key: 'character_consistency',
      label: 'Character consistency',
      score: 100,
      weight: 0.2,
      notes: 'No recurring characters in this project.',
    };
  }

  const locked = input.characters.filter((c) => c.locked).length;
  const sheeted = input.characters.filter((c) => c.referenceAssetId).length;
  const total = input.characters.length || 1;

  // A character with a reference sheet is genuinely pinned; a locked character
  // without one is only pinned by its text description.
  const score = Math.round((sheeted / total) * 70 + (locked / total) * 30);

  if (sheeted < total) {
    warnings.push(
      `${total - sheeted} character${total - sheeted === 1 ? '' : 's'} have no reference sheet, so their appearance may drift between scenes.`,
    );
  }

  return {
    key: 'character_consistency',
    label: 'Character consistency',
    score,
    weight: 0.2,
    notes: `${sheeted}/${total} characters anchored to a reference sheet, ${locked}/${total} locked.`,
  };
}

function scoreStyleConsistency(input: QualityInput, warnings: string[]): QualityMetric {
  const dna = input.styleDna;
  if (!dna) {
    warnings.push('No Style DNA was derived — scenes were generated without a shared visual profile.');
    return {
      key: 'style_consistency',
      label: 'Style consistency',
      score: 55,
      weight: 0.15,
      notes: 'No Style DNA profile exists for this project.',
    };
  }

  let score = 60;
  if (dna.promptSuffix.length > 60) score += 20;
  if (dna.sourceAssetIds.length >= 2) score += 10;
  if (dna.locked) score += 10;

  return {
    key: 'style_consistency',
    label: 'Style consistency',
    score: Math.min(100, score),
    weight: 0.15,
    notes: `Style DNA "${dna.name}" derived from ${dna.sourceAssetIds.length} reference image(s)${
      dna.locked ? ', locked' : ''
    }.`,
  };
}

function scoreVisualCoverage(input: QualityInput, warnings: string[]): QualityMetric {
  const total = input.scenes.length || 1;
  const withImage = input.scenes.filter((s) => s.imageAssetId).length;
  const withClip = input.scenes.filter((s) => s.clipAssetId).length;
  const failed = input.scenes.filter((s) => s.status === 'failed').length;

  // Still images are fine; a motion clip is better. Missing media is what hurts.
  const score = Math.round((withImage / total) * 80 + (withClip / total) * 20);

  if (failed > 0) {
    warnings.push(`${failed} scene${failed === 1 ? '' : 's'} failed to generate and fall back to a neutral slate.`);
  }
  if (withImage < total) {
    warnings.push(`${total - withImage} scene${total - withImage === 1 ? '' : 's'} have no generated image.`);
  }

  return {
    key: 'visual_quality',
    label: 'Visual coverage',
    score,
    weight: 0.2,
    notes: `${withImage}/${total} scenes have imagery, ${withClip}/${total} have motion clips.`,
  };
}

function scoreTimingAccuracy(input: QualityInput, warnings: string[]): QualityMetric {
  const scenes = [...input.scenes].sort((a, b) => a.index - b.index);
  if (scenes.length === 0) {
    return { key: 'timing', label: 'Timing accuracy', score: 0, weight: 0.15, notes: 'No scenes.' };
  }

  // Every gap or overlap between consecutive scenes is drift against the audio.
  let drift = 0;
  for (let i = 1; i < scenes.length; i += 1) {
    drift += Math.abs(scenes[i]!.startSec - scenes[i - 1]!.endSec);
  }

  const timelineEnd = scenes[scenes.length - 1]!.endSec;
  const audioDrift = Math.abs(timelineEnd - input.transcript.durationSec);
  const totalDrift = drift + audioDrift;

  const score = Math.max(0, Math.round(100 - (totalDrift / Math.max(1, input.transcript.durationSec)) * 400));

  if (audioDrift > 0.5) {
    warnings.push(
      `The timeline ends ${audioDrift.toFixed(2)}s ${
        timelineEnd > input.transcript.durationSec ? 'after' : 'before'
      } the narration.`,
    );
  }

  return {
    key: 'timing',
    label: 'Timing accuracy',
    score,
    weight: 0.15,
    notes: `Cumulative drift ${totalDrift.toFixed(3)}s across ${scenes.length} scenes (${(
      100 - (totalDrift / Math.max(1, input.transcript.durationSec)) * 100
    ).toFixed(2)}% aligned).`,
  };
}

function scoreCaptionQuality(input: QualityInput, warnings: string[]): QualityMetric {
  const caption = input.project.settings.caption;
  if (!caption.enabled) {
    return {
      key: 'captions',
      label: 'Caption quality',
      score: 100,
      weight: 0.1,
      notes: 'Captions are disabled for this project.',
    };
  }

  const words = input.transcript.segments.flatMap((s) => s.words);
  if (words.length === 0) {
    warnings.push('Captions are enabled but the transcript has no word-level timings.');
    return { key: 'captions', label: 'Caption quality', score: 30, weight: 0.1, notes: 'No timed words.' };
  }

  const timed = words.filter((w) => w.end > w.start).length;
  const confident = words.filter((w) => (w.confidence ?? 1) >= 0.7).length;
  const score = Math.round((timed / words.length) * 60 + (confident / words.length) * 40);

  if (confident / words.length < 0.8) {
    warnings.push('A significant share of words carry low transcription confidence; review the transcript.');
  }

  return {
    key: 'captions',
    label: 'Caption quality',
    score,
    weight: 0.1,
    notes: `${timed}/${words.length} words timed, ${Math.round((confident / words.length) * 100)}% high confidence.`,
  };
}

interface ModelScores {
  storyAlignment: QualityMetric;
  visualQuality: QualityMetric;
  warnings: string[];
}

async function scoreWithModel(input: QualityInput): Promise<ModelScores> {
  // A sample keeps the review prompt bounded on a 500-scene project.
  const sample = sampleScenes(input.scenes, 25).map((scene) => ({
    index: scene.index,
    durationSec: Number((scene.endSec - scene.startSec).toFixed(2)),
    narration: scene.narration.slice(0, 300),
    visualPrompt: scene.visualPrompt.slice(0, 300),
    emotion: scene.emotion,
    location: scene.location,
    hasImage: Boolean(scene.imageAssetId),
    hasClip: Boolean(scene.clipAssetId),
  }));

  const response = await generateJson<Record<string, unknown>>(
    { userId: input.project.userId, projectId: input.project.id },
    {
      prompt: qualityReviewPrompt({
        title: input.project.videoTitle ?? input.project.name,
        aspectRatio: input.project.aspectRatio,
        language: input.project.language,
        durationSec: input.transcript.durationSec,
        sceneCount: input.scenes.length,
        characters: input.characters.map((c) => ({ name: c.name, role: c.role })),
        styleSummary: input.styleDna?.summary ?? null,
        scenes: sample,
      }),
      system: QUALITY_REVIEW_SYSTEM,
      temperature: 0.2,
      maxOutputTokens: 4096,
    },
  );

  const story = response['storyAlignment'] as Record<string, unknown> | undefined;
  const visual = response['visualQuality'] as Record<string, unknown> | undefined;

  return {
    storyAlignment: {
      key: 'story_alignment',
      label: 'Story alignment',
      score: clampScore(asNumber(story?.['score'], 75)),
      weight: 0.2,
      notes: asString(story?.['notes']).slice(0, 600),
    },
    visualQuality: {
      key: 'visual_direction',
      label: 'Visual direction',
      score: clampScore(asNumber(visual?.['score'], 75)),
      weight: 0.1,
      notes: asString(visual?.['notes']).slice(0, 600),
    },
    warnings: asArray<unknown>(response['warnings'])
      .map((w) => asString(w).slice(0, 300))
      .filter(Boolean)
      .slice(0, 12),
  };
}

function sampleScenes(scenes: readonly Scene[], count: number): Scene[] {
  if (scenes.length <= count) return [...scenes];
  const step = scenes.length / count;
  return Array.from({ length: count }, (_, i) => scenes[Math.floor(i * step)]!);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function gradeFor(score: number): QualityReport['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
