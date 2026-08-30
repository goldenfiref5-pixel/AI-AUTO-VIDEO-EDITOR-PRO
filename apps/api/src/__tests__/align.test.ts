import { describe, expect, it } from 'vitest';
import type { TranscriptWord } from '@aiedit/shared';
import { enforceMonotonic, realignWords, segmentsFromWords } from '../pipeline/align';

function words(...pairs: Array<[string, number, number]>): TranscriptWord[] {
  return pairs.map(([text, start, end]) => ({ text, start, end }));
}

describe('realignWords', () => {
  const original = words(
    ['Once', 0, 0.4],
    ['upon', 0.4, 0.8],
    ['a', 0.8, 0.9],
    ['time', 0.9, 1.4],
    ['there', 1.4, 1.8],
    ['was', 1.8, 2.1],
    ['a', 2.1, 2.2],
    ['boy', 2.2, 2.7],
  );

  it('keeps original timings for untouched words', () => {
    const result = realignWords(original, 'Once upon a time there was a boy', 2.7);
    expect(result).toHaveLength(8);
    expect(result[0]).toMatchObject({ text: 'Once', start: 0, end: 0.4 });
    expect(result[7]).toMatchObject({ text: 'boy', start: 2.2, end: 2.7 });
  });

  it('anchors surviving words when a word is replaced', () => {
    const result = realignWords(original, 'Once upon a time there was a child', 2.7);
    expect(result[6]).toMatchObject({ text: 'a', start: 2.1 });
    // The replacement inherits the slot the removed word occupied.
    expect(result[7]!.text).toBe('child');
    expect(result[7]!.start).toBeGreaterThanOrEqual(2.2);
    expect(result[7]!.end).toBeLessThanOrEqual(2.7);
  });

  it('interpolates inserted words between their neighbours', () => {
    const result = realignWords(original, 'Once upon a time there really was a boy', 2.7);
    const inserted = result.find((w) => w.text === 'really');
    expect(inserted).toBeDefined();
    expect(inserted!.start).toBeGreaterThanOrEqual(1.4);
    expect(inserted!.end).toBeLessThanOrEqual(2.7);
  });

  it('never produces overlapping or backwards timings', () => {
    const result = realignWords(original, 'A completely different sentence entirely', 2.7);
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i]!.start).toBeGreaterThanOrEqual(result[i - 1]!.end - 1e-9);
      expect(result[i]!.end).toBeGreaterThan(result[i]!.start);
    }
  });

  it('handles an empty original word list', () => {
    const result = realignWords([], 'brand new narration here', 4);
    expect(result).toHaveLength(4);
    expect(result[0]!.start).toBe(0);
    expect(result[3]!.end).toBeLessThanOrEqual(4.001);
  });

  it('preserves non-Latin scripts', () => {
    const urdu = words(['ایک', 0, 0.5], ['لڑکا', 0.5, 1.2]);
    const result = realignWords(urdu, 'ایک لڑکا', 1.2);
    expect(result.map((w) => w.text)).toEqual(['ایک', 'لڑکا']);
    expect(result[1]).toMatchObject({ start: 0.5, end: 1.2 });
  });
});

describe('enforceMonotonic', () => {
  it('clamps to the total duration', () => {
    const result = enforceMonotonic(words(['a', 0, 5], ['b', 5, 12]), 8);
    expect(result[1]!.end).toBeLessThanOrEqual(8);
  });

  it('repairs a zero-length word', () => {
    const result = enforceMonotonic(words(['a', 1, 1]), 10);
    expect(result[0]!.end).toBeGreaterThan(result[0]!.start);
  });
});

describe('segmentsFromWords', () => {
  it('splits on sentence boundaries and carries timings', () => {
    const flat = words(
      ['Hello', 0, 0.4],
      ['there.', 0.4, 0.9],
      ['How', 0.9, 1.2],
      ['are', 1.2, 1.4],
      ['you?', 1.4, 1.9],
    );
    const segments = segmentsFromWords('Hello there. How are you?', flat);

    expect(segments).toHaveLength(2);
    expect(segments[0]!.text).toBe('Hello there.');
    expect(segments[0]!.start).toBe(0);
    expect(segments[0]!.end).toBe(0.9);
    expect(segments[1]!.words).toHaveLength(3);
  });

  it('claims trailing words that the splitter left over', () => {
    const flat = words(['One', 0, 0.3], ['two', 0.3, 0.6], ['three', 0.6, 1]);
    const segments = segmentsFromWords('One two', flat);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.words).toHaveLength(3);
    expect(segments[0]!.end).toBe(1);
  });
});
