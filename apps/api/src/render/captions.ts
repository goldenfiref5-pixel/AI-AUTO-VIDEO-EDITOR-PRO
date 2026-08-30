import type {
  CaptionSettings,
  Dimensions,
  TranscriptWord,
} from '@aiedit/shared';
import { RTL_LANGUAGES, formatAssTime, formatSrtTime } from '@aiedit/shared';

export interface CaptionCue {
  start: number;
  end: number;
  words: TranscriptWord[];
}

/**
 * Group words into cues.
 *
 * `word` mode emits tight groups that flash one phrase at a time (TikTok
 * style), `sentence` and `karaoke` group on punctuation so a full line stays on
 * screen while the highlight travels across it.
 */
export function buildCues(
  words: readonly TranscriptWord[],
  settings: CaptionSettings,
): CaptionCue[] {
  if (words.length === 0) return [];

  const cues: CaptionCue[] = [];
  let buffer: TranscriptWord[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    cues.push({
      start: buffer[0]!.start,
      end: buffer[buffer.length - 1]!.end,
      words: buffer,
    });
    buffer = [];
  };

  const endsSentence = (text: string) => /[.!?。！？۔؟।…]["'”’)\]]*$/.test(text);
  const endsClause = (text: string) => /[,;:،؛]$/.test(text);

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    buffer.push(word);

    const next = words[i + 1];
    // A pause longer than 700ms always breaks the cue — holding a caption over
    // silence reads as a sync error.
    const gap = next ? next.start - word.end : Infinity;

    const full = buffer.length >= settings.maxWordsPerCue;
    const sentenceBreak = settings.mode !== 'word' && endsSentence(word.text);
    const clauseBreak =
      settings.mode !== 'word' && endsClause(word.text) && buffer.length >= settings.maxWordsPerCue - 2;

    if (full || sentenceBreak || clauseBreak || gap > 0.7 || !next) flush();
  }
  flush();

  return cues;
}

function toAssColor(hex: string, alphaHex = '00'): string {
  const clean = hex.replace('#', '');
  const expanded =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.slice(0, 6);
  const r = expanded.slice(0, 2);
  const g = expanded.slice(2, 4);
  const b = expanded.slice(4, 6);
  // ASS colours are &HAABBGGRR — byte order is reversed relative to CSS.
  return `&H${alphaHex}${b}${g}${r}`.toUpperCase();
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
}

/** Alignment codes: 8 = top-centre, 5 = middle-centre, 2 = bottom-centre. */
function alignmentFor(position: CaptionSettings['position']): number {
  return position === 'top' ? 8 : position === 'center' ? 5 : 2;
}

export interface AssOptions {
  settings: CaptionSettings;
  canvas: Dimensions;
  language: string;
  /** Timeline offset applied to every cue, for rendering a partial range. */
  offsetSec?: number;
}

/**
 * Render cues to an Advanced SubStation Alpha file.
 *
 * ASS is used rather than SRT because it is the only subtitle format libass
 * (and therefore FFmpeg's `subtitles` filter) can style precisely enough for
 * word-level highlighting, karaoke timing and entry animations.
 */
export function buildAssFile(cues: readonly CaptionCue[], options: AssOptions): string {
  const { settings, canvas } = options;
  const offset = options.offsetSec ?? 0;
  const rtl = RTL_LANGUAGES.has(options.language.slice(0, 2));

  // Font size is authored against a 1080-wide canvas; scale it to the real one.
  const scale = Math.min(canvas.width, canvas.height) / 1080;
  const fontSize = Math.max(12, Math.round(settings.fontSize * Math.max(0.5, scale)));
  const marginV = Math.round(settings.marginVertical * Math.max(0.5, scale));
  const outline = Math.max(0, settings.outlineWidth * Math.max(0.5, scale));
  const shadow = Math.max(0, settings.shadowDepth * Math.max(0.5, scale));

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Caption',
      settings.fontFamily,
      String(fontSize),
      toAssColor(settings.primaryColor),
      toAssColor(settings.highlightColor),
      toAssColor(settings.outlineColor),
      toAssColor(settings.shadowColor, '40'),
      '-1', // bold
      '0',
      '0',
      '0',
      '100',
      '100',
      '0',
      '0',
      '1', // outline + drop shadow border style
      outline.toFixed(1),
      shadow.toFixed(1),
      String(alignmentFor(settings.position)),
      String(Math.round(canvas.width * 0.06)),
      String(Math.round(canvas.width * 0.06)),
      String(marginV),
      '1',
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const keywords = new Set(settings.keywords.map((k) => k.toLowerCase()));

  // Anchor point for movement effects, matching the style's alignment so a
  // \move override lands where the un-animated caption would have sat.
  const anchor = {
    x: Math.round(canvas.width / 2),
    y:
      settings.position === 'top'
        ? marginV
        : settings.position === 'center'
          ? Math.round(canvas.height / 2)
          : canvas.height - marginV,
  };

  const events = cues.map((cue) => {
    const start = Math.max(0, cue.start + offset);
    const end = Math.max(start + 0.05, cue.end + offset);
    const text = renderCueText(cue, settings, keywords, rtl, anchor);
    return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Caption,,0,0,0,,${text}`;
  });

  return `${header}\n${events.join('\n')}\n`;
}

function renderCueText(
  cue: CaptionCue,
  settings: CaptionSettings,
  keywords: ReadonlySet<string>,
  rtl: boolean,
  anchor: { x: number; y: number },
): string {
  const words = rtl ? [...cue.words].reverse() : cue.words;
  const transform = (t: string) => (settings.uppercase ? t.toUpperCase() : t);

  const entry = entryEffect(settings, cue, anchor);

  if (settings.mode === 'karaoke') {
    // \k timings are in centiseconds and are relative to the cue start.
    const spans = words.map((word) => {
      const durationCs = Math.max(1, Math.round((word.end - word.start) * 100));
      const highlight = keywords.has(stripPunctuation(word.text).toLowerCase());
      const colour = highlight ? `{\\c${toAssColor(settings.highlightColor)}}` : '';
      const reset = highlight ? `{\\c${toAssColor(settings.primaryColor)}}` : '';
      return `{\\kf${durationCs}}${colour}${escapeAssText(transform(word.text))}${reset} `;
    });
    // Karaoke needs SecondaryColour as the "not yet sung" colour.
    return `${entry}{\\2c${toAssColor(settings.primaryColor)}\\c${toAssColor(settings.highlightColor)}}${spans.join('').trimEnd()}`;
  }

  if (settings.mode === 'word' && words.length > 1) {
    // Progressive reveal: each word pops to the highlight colour at its own
    // timestamp using \t transforms relative to the cue start.
    const spans = words.map((word) => {
      const at = Math.max(0, Math.round((word.start - cue.start) * 1000));
      const highlight = keywords.has(stripPunctuation(word.text).toLowerCase());
      const colour = toAssColor(highlight ? settings.highlightColor : settings.primaryColor);
      return `{\\c${toAssColor(settings.primaryColor)}\\t(${at},${at + 90},\\c${colour}\\fscx108\\fscy108)\\t(${
        at + 90
      },${at + 220},\\fscx100\\fscy100)}${escapeAssText(transform(word.text))}`;
    });
    return `${entry}${spans.join(' ')}`;
  }

  const rendered = words
    .map((word) => {
      const highlight = keywords.has(stripPunctuation(word.text).toLowerCase());
      const text = escapeAssText(transform(word.text));
      return highlight ? `{\\c${toAssColor(settings.highlightColor)}}${text}{\\c${toAssColor(settings.primaryColor)}}` : text;
    })
    .join(' ');

  return `${entry}${rendered}`;
}

function entryEffect(
  settings: CaptionSettings,
  cue: CaptionCue,
  anchor: { x: number; y: number },
): string {
  switch (settings.animation) {
    case 'fade':
      return '{\\fad(120,120)}';
    case 'pop':
      return '{\\fad(60,60)\\fscx60\\fscy60\\t(0,110,\\fscx104\\fscy104)\\t(110,190,\\fscx100\\fscy100)}';
    case 'slide-up': {
      // \move overrides positioning, so it is anchored to the same point the
      // style's alignment and margins would have produced.
      const from = anchor.y + 48;
      return `{\\fad(80,80)\\move(${anchor.x},${from},${anchor.x},${anchor.y},0,180)}`;
    }
    case 'typewriter':
      // Approximated as a fast reveal: a true per-character typewriter needs one
      // Dialogue event per character, which is unusable at transcript length.
      return '{\\fad(30,60)\\fscx70\\t(0,150,\\fscx100)}';
    case 'none':
    default:
      return '';
  }
}

function stripPunctuation(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, '');
}

/** SRT export for users who want to burn captions elsewhere. */
export function buildSrtFile(cues: readonly CaptionCue[]): string {
  return cues
    .map((cue, index) => {
      const text = cue.words.map((w) => w.text).join(' ');
      return `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${text}\n`;
    })
    .join('\n');
}

/** WebVTT export, for HTML5 players. */
export function buildVttFile(cues: readonly CaptionCue[]): string {
  const body = cues
    .map((cue) => {
      const text = cue.words.map((w) => w.text).join(' ');
      return `${formatSrtTime(cue.start).replace(',', '.')} --> ${formatSrtTime(cue.end).replace(',', '.')}\n${text}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
