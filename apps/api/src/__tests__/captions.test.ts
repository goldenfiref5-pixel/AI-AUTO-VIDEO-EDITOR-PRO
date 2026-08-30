import { describe, expect, it } from 'vitest';
import { captionPreset } from '@aiedit/shared';
import type { TranscriptWord } from '@aiedit/shared';
import { buildAssFile, buildCues, buildSrtFile } from '../render/captions';

function words(...pairs: Array<[string, number, number]>): TranscriptWord[] {
  return pairs.map(([text, start, end]) => ({ text, start, end }));
}

describe('buildCues', () => {
  it('respects the maximum words per cue', () => {
    const settings = { ...captionPreset('tiktok'), maxWordsPerCue: 2 };
    const cues = buildCues(
      words(['one', 0, 0.2], ['two', 0.2, 0.4], ['three', 0.4, 0.6], ['four', 0.6, 0.8]),
      settings,
    );
    expect(cues).toHaveLength(2);
    expect(cues[0]!.words.map((w) => w.text)).toEqual(['one', 'two']);
  });

  it('breaks on a long pause even below the word limit', () => {
    const settings = { ...captionPreset('documentary'), maxWordsPerCue: 12 };
    const cues = buildCues(words(['before', 0, 0.4], ['after', 3, 3.4]), settings);
    expect(cues).toHaveLength(2);
  });

  it('breaks on sentence terminators in sentence mode', () => {
    const settings = { ...captionPreset('documentary'), maxWordsPerCue: 20 };
    const cues = buildCues(
      words(['Stop.', 0, 0.3], ['Next', 0.3, 0.6], ['sentence.', 0.6, 1]),
      settings,
    );
    expect(cues).toHaveLength(2);
    expect(cues[0]!.words.map((w) => w.text)).toEqual(['Stop.']);
  });

  it('handles an empty word list', () => {
    expect(buildCues([], captionPreset('minimal'))).toEqual([]);
  });
});

describe('buildAssFile', () => {
  const canvas = { width: 1080, height: 1920 };

  it('emits a valid ASS header sized to the canvas', () => {
    const cues = buildCues(words(['hello', 0, 0.5], ['world', 0.5, 1]), captionPreset('tiktok'));
    const ass = buildAssFile(cues, { settings: captionPreset('tiktok'), canvas, language: 'en' });

    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('Dialogue: 0,');
  });

  it('converts hex colours to ASS BGR order', () => {
    const settings = { ...captionPreset('minimal'), primaryColor: '#112233' };
    const cues = buildCues(words(['x', 0, 0.4]), settings);
    const ass = buildAssFile(cues, { settings, canvas, language: 'en' });
    // #112233 -> &H00332211
    expect(ass).toContain('&H00332211');
  });

  it('emits karaoke timings in centiseconds', () => {
    const settings = { ...captionPreset('reels'), mode: 'karaoke' as const };
    const cues = buildCues(words(['sing', 0, 0.5], ['along', 0.5, 1.2]), settings);
    const ass = buildAssFile(cues, { settings, canvas, language: 'en' });

    expect(ass).toMatch(/\\kf50/);
    expect(ass).toMatch(/\\kf70/);
  });

  it('escapes brace characters that would be read as override tags', () => {
    const settings = captionPreset('minimal');
    const cues = buildCues(words(['{weird}', 0, 0.5]), settings);
    const ass = buildAssFile(cues, { settings, canvas, language: 'en' });
    expect(ass).toContain('\\{weird\\}');
  });

  it('reverses word order for right-to-left languages', () => {
    const settings = captionPreset('minimal');
    const cues = buildCues(words(['اول', 0, 0.4], ['دوم', 0.4, 0.8]), settings);
    const ass = buildAssFile(cues, { settings, canvas, language: 'ur' });
    const dialogue = ass.split('\n').find((line) => line.startsWith('Dialogue:'))!;
    expect(dialogue.indexOf('دوم')).toBeLessThan(dialogue.indexOf('اول'));
  });

  it('highlights configured keywords', () => {
    const settings = { ...captionPreset('minimal'), keywords: ['treasure'], highlightColor: '#FF0000' };
    const cues = buildCues(words(['the', 0, 0.2], ['treasure!', 0.2, 0.9]), settings);
    const ass = buildAssFile(cues, { settings, canvas, language: 'en' });
    expect(ass).toContain('&H000000FF');
  });
});

describe('buildSrtFile', () => {
  it('numbers cues from one and uses comma millisecond separators', () => {
    const cues = buildCues(words(['a', 0, 1], ['b', 2, 3]), {
      ...captionPreset('minimal'),
      maxWordsPerCue: 1,
    });
    const srt = buildSrtFile(cues);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,000');
    expect(srt).toContain('2\n00:00:02,000 --> 00:00:03,000');
  });
});
