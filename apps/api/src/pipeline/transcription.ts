import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptSegment, TranscriptWord } from '@aiedit/shared';
import { logger } from '../config/logger';
import { analyzeMedia } from '../gemini/service';
import { asNumber, asString, parseJsonLoose } from '../utils/json';
import { countWords } from '../utils/text';
import { probeMedia, runFfmpeg, toTranscriptionAudio } from '../render/ffmpeg';
import { enforceMonotonic } from './align';
import { TRANSCRIPTION_SYSTEM, transcriptionPrompt } from './prompts';

/**
 * Long audio is transcribed in windows. Word-level timings for a two-hour file
 * would blow past the model's output budget in a single call, and a shorter
 * window also keeps timing drift bounded.
 */
const CHUNK_SECONDS = 600;
/** Overlap lets the model see enough context to punctuate the seam correctly. */
const CHUNK_OVERLAP_SECONDS = 4;

interface RawSegment {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  speaker?: unknown;
  words?: Array<{ text?: unknown; start?: unknown; end?: unknown; confidence?: unknown }>;
}

interface RawTranscription {
  language?: unknown;
  confidence?: unknown;
  segments?: RawSegment[];
}

export interface TranscriptionResult {
  language: string;
  confidence: number;
  segments: TranscriptSegment[];
  text: string;
  wordCount: number;
  durationSec: number;
}

export interface TranscribeParams {
  userId: string;
  projectId: string;
  /** Local path to the uploaded voiceover. */
  audioPath: string;
  languageHint: string;
  onProgress?: (fraction: number, message: string) => void;
}

export async function transcribeAudio(params: TranscribeParams): Promise<TranscriptionResult> {
  const info = await probeMedia(params.audioPath);
  if (!info.hasAudio) {
    throw new Error('The uploaded file contains no audio stream.');
  }
  const durationSec = info.durationSec;

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'aiedit-tx-'));
  try {
    params.onProgress?.(0.05, 'Preparing audio');
    const normalized = await toTranscriptionAudio(
      params.audioPath,
      path.join(workDir, 'source.flac'),
    );

    const windows = planWindows(durationSec);
    logger.info(
      { projectId: params.projectId, durationSec, windows: windows.length },
      'Starting transcription',
    );

    const allSegments: TranscriptSegment[] = [];
    let language = params.languageHint === 'auto' || params.languageHint === 'mixed' ? 'en' : params.languageHint;
    let confidenceSum = 0;

    for (let i = 0; i < windows.length; i += 1) {
      const window = windows[i]!;
      params.onProgress?.(
        0.05 + (i / windows.length) * 0.9,
        `Transcribing ${Math.round(window.start)}s – ${Math.round(window.end)}s`,
      );

      const chunkPath =
        windows.length === 1
          ? normalized
          : await sliceAudio(normalized, window.start, window.end - window.start, path.join(workDir, `chunk-${i}.flac`));

      const raw = await analyzeMedia(
        { userId: params.userId, projectId: params.projectId },
        {
          filePath: chunkPath,
          mimeType: 'audio/flac',
          displayName: `voiceover-chunk-${i}`,
          prompt: transcriptionPrompt(params.languageHint, window.end - window.start),
          system: TRANSCRIPTION_SYSTEM,
          durationSec: window.end - window.start,
        },
        'transcription',
      );

      const parsed = parseJsonLoose<RawTranscription>(raw);
      if (i === 0 && typeof parsed.language === 'string' && parsed.language) {
        language = parsed.language.slice(0, 16);
      }
      confidenceSum += Math.min(1, Math.max(0, asNumber(parsed.confidence, 0.9)));

      const segments = normalizeRawSegments(parsed.segments ?? [], window.start, window.end);
      // Windows overlap, so drop anything that starts before the previous
      // window's committed boundary.
      const committedFrom = i === 0 ? 0 : window.start + (window.overlap ? CHUNK_OVERLAP_SECONDS / 2 : 0);
      for (const segment of segments) {
        if (segment.end <= committedFrom) continue;
        allSegments.push(segment);
      }
    }

    params.onProgress?.(0.97, 'Aligning timings');

    const merged = dedupeAndReindex(allSegments, durationSec);
    const text = merged.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();

    return {
      language,
      confidence: windows.length ? confidenceSum / windows.length : 0.9,
      segments: merged,
      text: paragraphize(merged),
      wordCount: countWords(text),
      durationSec,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface Window {
  start: number;
  end: number;
  overlap: boolean;
}

function planWindows(durationSec: number): Window[] {
  if (durationSec <= CHUNK_SECONDS) return [{ start: 0, end: durationSec, overlap: false }];

  const windows: Window[] = [];
  let cursor = 0;
  while (cursor < durationSec) {
    const start = cursor === 0 ? 0 : cursor - CHUNK_OVERLAP_SECONDS;
    const end = Math.min(durationSec, cursor + CHUNK_SECONDS);
    windows.push({ start, end, overlap: cursor > 0 });
    cursor = end;
    if (end >= durationSec) break;
  }
  return windows;
}

async function sliceAudio(
  input: string,
  startSec: number,
  durationSec: number,
  output: string,
): Promise<string> {
  await runFfmpeg({
    args: [
      '-ss', startSec.toFixed(3),
      '-t', durationSec.toFixed(3),
      '-i', input,
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'flac',
      output,
    ],
    timeoutMs: 10 * 60_000,
  });
  return output;
}

/** Convert the model's raw JSON into validated segments on the global timeline. */
function normalizeRawSegments(
  raw: RawSegment[],
  offsetSec: number,
  windowEndSec: number,
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];

  for (const item of raw) {
    const text = asString(item.text).trim();
    if (!text) continue;

    const start = clamp(asNumber(item.start, 0) + offsetSec, 0, windowEndSec);
    const end = clamp(asNumber(item.end, start + 1) + offsetSec, start, windowEndSec);

    const words: TranscriptWord[] = [];
    for (const w of item.words ?? []) {
      const wordText = asString(w.text).trim();
      if (!wordText) continue;
      const ws = clamp(asNumber(w.start, start) + offsetSec, 0, windowEndSec);
      const we = clamp(asNumber(w.end, ws + 0.2) + offsetSec, ws, windowEndSec);
      const word: TranscriptWord = { text: wordText, start: ws, end: we };
      if (w.confidence !== undefined) word.confidence = asNumber(w.confidence, 0.9);
      words.push(word);
    }

    segments.push({
      id: `seg-${segments.length}`,
      index: segments.length,
      text,
      start,
      end,
      speaker: typeof item.speaker === 'string' && item.speaker ? item.speaker : null,
      words: words.length ? words : synthesizeWords(text, start, end),
    });
  }

  return segments;
}

/** Fallback when the model returns a segment without per-word timings. */
function synthesizeWords(text: string, start: number, end: number): TranscriptWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const step = (end - start) / tokens.length;
  return tokens.map((token, i) => ({
    text: token,
    start: start + i * step,
    end: start + (i + 1) * step,
    confidence: 0.6,
  }));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Drop seam duplicates, enforce ordering, and renumber. */
function dedupeAndReindex(segments: TranscriptSegment[], durationSec: number): TranscriptSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const out: TranscriptSegment[] = [];

  for (const segment of sorted) {
    const previous = out[out.length - 1];
    if (previous) {
      const sameText = previous.text.trim().toLowerCase() === segment.text.trim().toLowerCase();
      const overlapping = segment.start < previous.end - 0.05;
      if (sameText && overlapping) continue;
      if (segment.start < previous.end) segment.start = previous.end;
      if (segment.end <= segment.start) segment.end = segment.start + 0.2;
    }
    out.push(segment);
  }

  return out.map((segment, index) => ({
    ...segment,
    id: `seg-${index}`,
    index,
    words: enforceMonotonic(segment.words, durationSec),
  }));
}

/** Group segments into readable paragraphs for the review screen. */
function paragraphize(segments: readonly TranscriptSegment[]): string {
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  let bufferStart = segments[0]?.start ?? 0;

  for (const segment of segments) {
    buffer.push(segment.text.trim());
    const spanSec = segment.end - bufferStart;
    // A paragraph closes after ~15s of narration or 3 sentences, whichever
    // comes first — this matches how the review screen reads best.
    if (spanSec >= 15 || buffer.length >= 3) {
      paragraphs.push(buffer.join(' '));
      buffer = [];
      bufferStart = segment.end;
    }
  }
  if (buffer.length) paragraphs.push(buffer.join(' '));

  return paragraphs.join('\n\n');
}
