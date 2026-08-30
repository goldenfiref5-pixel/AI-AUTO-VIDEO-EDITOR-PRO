import type { Project, Transcript, TranscriptSegment } from '@aiedit/shared';
import { generateJson } from '../gemini/service';
import { asArray, asNumber, asString } from '../utils/json';
import { countWords } from '../utils/text';
import { SCRIPT_ENHANCEMENT_SYSTEM, scriptEnhancementPrompt } from '../pipeline/prompts';

export interface EnhanceOptions {
  fixGrammar: boolean;
  improvePunctuation: boolean;
  improveReadability: boolean;
  instructions?: string;
}

export interface SegmentDiff {
  index: number;
  before: string;
  after: string;
  changed: boolean;
}

export interface EnhancementProposal {
  /** The proposed transcript text. Nothing is written until the user accepts. */
  text: string;
  segments: TranscriptSegment[];
  diffs: SegmentDiff[];
  changedCount: number;
  wordCountBefore: number;
  wordCountAfter: number;
}

/** Segments per model call — keeps each request inside the output budget. */
const BATCH = 40;

/**
 * Produce an improved script as a *proposal*.
 *
 * The result is returned to the client for review rather than saved: the
 * product requirement is that AI edits never land without explicit approval.
 * Timings are preserved segment-for-segment, so accepting the proposal cannot
 * desynchronise the video.
 */
export async function enhanceScript(
  project: Project,
  transcript: Transcript,
  options: EnhanceOptions,
): Promise<EnhancementProposal> {
  const segments = transcript.segments;
  if (segments.length === 0) {
    return {
      text: transcript.text,
      segments,
      diffs: [],
      changedCount: 0,
      wordCountBefore: transcript.wordCount,
      wordCountAfter: transcript.wordCount,
    };
  }

  const edited = new Map<number, string>();

  for (let offset = 0; offset < segments.length; offset += BATCH) {
    const batch = segments.slice(offset, offset + BATCH);
    const response = await generateJson<{ segments?: unknown }>(
      { userId: project.userId, projectId: project.id },
      {
        prompt: scriptEnhancementPrompt(
          batch.map((segment) => ({ index: segment.index, text: segment.text })),
          options,
        ),
        system: SCRIPT_ENHANCEMENT_SYSTEM,
        temperature: 0.2,
        maxOutputTokens: 16_384,
      },
    );

    for (const raw of asArray<Record<string, unknown>>(response.segments)) {
      const index = asNumber(raw['index'], -1);
      const text = asString(raw['text']).trim();
      if (index >= 0 && text) edited.set(index, text);
    }
  }

  const proposedSegments: TranscriptSegment[] = segments.map((segment) => {
    const replacement = edited.get(segment.index);
    if (!replacement || replacement === segment.text) return segment;

    // Word timings are stretched across the segment's existing span, so the
    // segment's start and end — and therefore the scene boundaries — are
    // unchanged by an edit.
    return {
      ...segment,
      text: replacement,
      words: redistribute(replacement, segment.start, segment.end),
    };
  });

  const diffs: SegmentDiff[] = segments.map((segment, i) => ({
    index: segment.index,
    before: segment.text,
    after: proposedSegments[i]!.text,
    changed: proposedSegments[i]!.text !== segment.text,
  }));

  const text = proposedSegments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join('\n\n');

  return {
    text,
    segments: proposedSegments,
    diffs,
    changedCount: diffs.filter((d) => d.changed).length,
    wordCountBefore: transcript.wordCount,
    wordCountAfter: countWords(text),
  };
}

/** Spread a rewritten sentence's words evenly across the original span. */
function redistribute(text: string, start: number, end: number) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const step = (end - start) / tokens.length;

  return tokens.map((token, i) => ({
    text: token,
    start: Number((start + i * step).toFixed(3)),
    end: Number((start + (i + 1) * step).toFixed(3)),
    confidence: 0.9,
  }));
}
