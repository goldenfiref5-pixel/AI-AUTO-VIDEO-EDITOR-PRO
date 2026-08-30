import type { TranscriptSegment, TranscriptWord } from '@aiedit/shared';

/** Unicode-aware word tokeniser that keeps Arabic/Urdu/Devanagari intact. */
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*|[\p{Extended_Pictographic}]/gu;

export function tokenizeWords(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

export function countWords(text: string): number {
  return tokenizeWords(text).length;
}

/**
 * Split into sentences, honouring Latin, Arabic (`؟` `۔`), Devanagari (`।`) and
 * CJK terminators, and falling back to line breaks for unpunctuated dictation.
 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  const parts: string[] = [];
  let buffer = '';
  const terminators = new Set(['.', '!', '?', '。', '！', '？', '۔', '؟', '।', '…']);

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    buffer += ch;
    if (terminators.has(ch)) {
      // Swallow trailing quotes/brackets so they stay with the sentence.
      while (i + 1 < normalized.length && /["'”’)\]]/.test(normalized[i + 1]!)) {
        i += 1;
        buffer += normalized[i];
      }
      parts.push(buffer.trim());
      buffer = '';
    } else if (ch === '\n' && buffer.trim().length > 0) {
      parts.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) parts.push(buffer.trim());

  return parts.filter(Boolean);
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Compare words ignoring case, punctuation and diacritics-as-separate-marks. */
export function normalizeForMatch(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function flattenWords(segments: readonly TranscriptSegment[]): TranscriptWord[] {
  return segments.flatMap((s) => s.words);
}

export function segmentsToText(segments: readonly TranscriptSegment[]): string {
  return segments.map((s) => s.text.trim()).filter(Boolean).join('\n\n');
}

/** Truncate on a word boundary, appending an ellipsis when cut. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rough syllable count — the timing estimator's proxy for speaking effort. */
export function estimateSyllables(word: string): number {
  const clean = normalizeForMatch(word);
  if (!clean) return 0;
  // Non-Latin scripts: character count is a better proxy than vowel groups.
  if (!/^[a-z0-9]+$/.test(clean)) return Math.max(1, Math.ceil(clean.length / 2));
  const groups = clean.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}
