import type { TranscriptSegment, TranscriptWord } from '@aiedit/shared';
import { estimateSyllables, normalizeForMatch, splitSentences, tokenizeWords } from '../utils/text';

/**
 * Longest-common-subsequence over normalised tokens. Used to carry original
 * audio timings across a user's transcript edits.
 *
 * The classic O(n*m) table is fine for a few thousand words but blows up on a
 * 100k-word transcript, so the input is first split on anchor runs of
 * identical tokens and each gap is solved independently.
 */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  // Guard: fall back to a positional match for pathologically large gaps.
  if (n * m > 4_000_000) {
    const pairs: Array<[number, number]> = [];
    const count = Math.min(n, m);
    for (let i = 0; i < count; i += 1) {
      if (a[i] === b[i]) pairs.push([i, i]);
    }
    return pairs;
  }

  const table: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        a[i] === b[j]
          ? table[at(i + 1, j + 1)]! + 1
          : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** Split a long alignment into anchored chunks so LCS stays tractable. */
function alignTokens(oldTokens: readonly string[], newTokens: readonly string[]): Array<[number, number]> {
  const CHUNK = 1200;
  if (oldTokens.length <= CHUNK && newTokens.length <= CHUNK) {
    return lcsPairs(oldTokens, newTokens);
  }

  const pairs: Array<[number, number]> = [];
  let oldStart = 0;
  let newStart = 0;

  while (oldStart < oldTokens.length && newStart < newTokens.length) {
    const oldEnd = Math.min(oldStart + CHUNK, oldTokens.length);
    const newEnd = Math.min(newStart + CHUNK, newTokens.length);

    const local = lcsPairs(oldTokens.slice(oldStart, oldEnd), newTokens.slice(newStart, newEnd));
    for (const [oi, ni] of local) pairs.push([oi + oldStart, ni + newStart]);

    // Advance past the last matched pair so the next window resynchronises.
    const last = local[local.length - 1];
    if (last) {
      oldStart += last[0] + 1;
      newStart += last[1] + 1;
    } else {
      oldStart = oldEnd;
      newStart = newEnd;
    }
  }

  return pairs;
}

/**
 * Re-time an edited transcript against the original word timings.
 *
 * Words that survive the edit keep their exact timing. Runs of inserted or
 * rewritten words are distributed across the gap between their surviving
 * neighbours, weighted by estimated syllable count so long words get more
 * screen time than short ones.
 */
export function realignWords(
  originalWords: readonly TranscriptWord[],
  newText: string,
  totalDurationSec: number,
): TranscriptWord[] {
  const newTokens = tokenizeWords(newText);
  if (newTokens.length === 0) return [];

  if (originalWords.length === 0) {
    return distributeEvenly(newTokens, 0, totalDurationSec);
  }

  const oldNorm = originalWords.map((w) => normalizeForMatch(w.text));
  const newNorm = newTokens.map(normalizeForMatch);
  const pairs = alignTokens(oldNorm, newNorm);

  const result: TranscriptWord[] = new Array(newTokens.length);

  // 1. Anchor every matched word to its original timing.
  for (const [oldIdx, newIdx] of pairs) {
    const source = originalWords[oldIdx]!;
    result[newIdx] = {
      text: newTokens[newIdx]!,
      start: source.start,
      end: source.end,
      confidence: source.confidence,
    };
  }

  // 2. Fill each unanchored run by interpolating between its neighbours.
  let cursor = 0;
  while (cursor < newTokens.length) {
    if (result[cursor]) {
      cursor += 1;
      continue;
    }
    let runEnd = cursor;
    while (runEnd < newTokens.length && !result[runEnd]) runEnd += 1;

    const before = cursor > 0 ? result[cursor - 1] : undefined;
    const after = runEnd < newTokens.length ? result[runEnd] : undefined;

    const windowStart = before?.end ?? 0;
    const windowEnd = after?.start ?? Math.max(windowStart + 0.3, totalDurationSec);

    const filled = distributeEvenly(newTokens.slice(cursor, runEnd), windowStart, windowEnd);
    for (let i = 0; i < filled.length; i += 1) result[cursor + i] = filled[i]!;

    cursor = runEnd;
  }

  return enforceMonotonic(result, totalDurationSec);
}

/** Spread tokens across a window proportionally to speaking effort. */
function distributeEvenly(tokens: readonly string[], start: number, end: number): TranscriptWord[] {
  if (tokens.length === 0) return [];
  const span = Math.max(0.08 * tokens.length, end - start);
  const weights = tokens.map((t) => Math.max(0.5, estimateSyllables(t)));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0) || tokens.length;

  const out: TranscriptWord[] = [];
  let cursor = start;
  for (let i = 0; i < tokens.length; i += 1) {
    const share = (weights[i]! / totalWeight) * span;
    out.push({ text: tokens[i]!, start: cursor, end: cursor + share, confidence: 0.5 });
    cursor += share;
  }
  return out;
}

/** Clamp timings so they never overlap or run backwards. */
export function enforceMonotonic(words: TranscriptWord[], totalDurationSec: number): TranscriptWord[] {
  const MIN = 0.04;
  let previousEnd = 0;

  return words.map((word) => {
    let start = Math.max(previousEnd, Number.isFinite(word.start) ? word.start : previousEnd);
    let end = Number.isFinite(word.end) ? word.end : start + MIN;
    if (end <= start) end = start + MIN;
    if (totalDurationSec > 0) {
      start = Math.min(start, totalDurationSec);
      end = Math.min(end, totalDurationSec);
      if (end <= start) {
        start = Math.max(0, totalDurationSec - MIN);
        end = totalDurationSec;
      }
    }
    previousEnd = end;
    return { ...word, start: round3(start), end: round3(end) };
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Rebuild sentence-level segments from a flat word list, keeping the user's
 * paragraph breaks where they exist.
 */
export function segmentsFromWords(text: string, words: readonly TranscriptWord[]): TranscriptSegment[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const segments: TranscriptSegment[] = [];
  let wordCursor = 0;

  sentences.forEach((sentence, index) => {
    const tokenCount = tokenizeWords(sentence).length;
    if (tokenCount === 0) return;

    const slice = words.slice(wordCursor, wordCursor + tokenCount);
    wordCursor += tokenCount;
    if (slice.length === 0) return;

    segments.push({
      id: `seg-${index}`,
      index: segments.length,
      text: sentence,
      start: slice[0]!.start,
      end: slice[slice.length - 1]!.end,
      speaker: null,
      words: slice,
    });
  });

  // Any trailing words the sentence splitter did not claim join the last segment.
  if (wordCursor < words.length && segments.length > 0) {
    const last = segments[segments.length - 1]!;
    const tail = words.slice(wordCursor);
    last.words = [...last.words, ...tail];
    last.end = tail[tail.length - 1]!.end;
  }

  return segments;
}

/** Reindex and stamp stable ids after an edit reorders segments. */
export function normalizeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.map((segment, index) => ({
    ...segment,
    id: segment.id || `seg-${index}`,
    index,
  }));
}
