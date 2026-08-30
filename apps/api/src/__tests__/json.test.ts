import { describe, expect, it } from 'vitest';
import { deepMerge, parseJsonLoose, tryParseJson } from '../utils/json';

describe('parseJsonLoose', () => {
  it('parses plain JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('unwraps a fenced code block', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts JSON embedded in prose', () => {
    expect(parseJsonLoose('Here you go:\n{"scenes":[{"index":0}]}\nHope that helps!')).toEqual({
      scenes: [{ index: 0 }],
    });
  });

  it('repairs trailing commas', () => {
    expect(parseJsonLoose('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  it('ignores braces inside string values', () => {
    expect(parseJsonLoose('{"text":"a } brace","n":2}')).toEqual({ text: 'a } brace', n: 2 });
  });

  it('handles escaped quotes inside strings', () => {
    expect(parseJsonLoose('{"text":"she said \\"hi\\"","n":1}')).toEqual({
      text: 'she said "hi"',
      n: 1,
    });
  });

  it('throws with a truncated preview when nothing parses', () => {
    expect(() => parseJsonLoose('not json at all')).toThrow(/not valid JSON/);
  });

  it('returns null from tryParseJson instead of throwing', () => {
    expect(tryParseJson('nope')).toBeNull();
  });
});

describe('deepMerge', () => {
  it('merges nested objects', () => {
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });

  it('replaces arrays wholesale rather than merging them', () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it('ignores undefined patch values', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it('returns the base when the patch is null', () => {
    expect(deepMerge({ a: 1 }, null)).toEqual({ a: 1 });
  });
});
