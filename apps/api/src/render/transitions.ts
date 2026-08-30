import type { TransitionSettings, TransitionType } from '@aiedit/shared';

/**
 * Maps our editorial transition vocabulary onto FFmpeg `xfade` transitions.
 * `motion_cut` and `match_cut` deliberately have no xfade equivalent: they are
 * hard cuts, which is exactly what those terms mean in an edit.
 */
const XFADE: Record<TransitionType, string | null> = {
  fade: 'fade',
  zoom: 'zoomin',
  blur: 'fadeblack',
  motion_cut: null,
  dynamic_swipe: 'slideleft',
  match_cut: null,
  speed_ramp: 'fadewhite',
  cinematic: 'smoothleft',
};

export interface ResolvedTransition {
  type: TransitionType;
  /** null means a hard cut — the renderer concatenates without a blend. */
  xfade: string | null;
  durationSec: number;
}

export interface TransitionContext {
  index: number;
  /** Duration of the outgoing clip; a transition can never exceed it. */
  previousDurationSec: number;
  nextDurationSec: number;
  /** True when the story crosses into a new location or emotional beat. */
  isBeatChange: boolean;
  /** Explicit user choice on the scene, if any. */
  requested: TransitionType | null;
}

/**
 * Choose a transition for one cut.
 *
 * Intensity governs both which transitions are eligible and how long they run:
 * at 0 everything is a hard cut, at 1 every cut is stylised. Beat changes get
 * the more expressive options; cuts inside a beat stay quiet so the edit does
 * not feel busy.
 */
export function resolveTransition(
  settings: TransitionSettings,
  context: TransitionContext,
): ResolvedTransition {
  if (!settings.enabled) {
    return { type: 'motion_cut', xfade: null, durationSec: 0 };
  }

  if (context.requested) {
    return {
      type: context.requested,
      xfade: XFADE[context.requested],
      durationSec: clampDuration(settings.durationSec, context),
    };
  }

  const palette = settings.types.length
    ? settings.types
    : defaultPalette(settings.intensity, context.isBeatChange);

  // Deterministic rotation keeps re-renders identical and stops the same
  // transition landing on every cut.
  const type = palette[context.index % palette.length]!;

  // Below the intensity threshold a cut stays hard, so low intensity really is
  // mostly cuts rather than short dissolves everywhere.
  const stylizedShare = settings.intensity;
  const shouldStylize = context.isBeatChange
    ? stylizedShare > 0.15
    : hash(context.index) < stylizedShare;

  if (!shouldStylize) {
    return { type: 'motion_cut', xfade: null, durationSec: 0 };
  }

  return { type, xfade: XFADE[type], durationSec: clampDuration(settings.durationSec, context) };
}

function defaultPalette(intensity: number, isBeatChange: boolean): TransitionType[] {
  if (intensity < 0.25) return ['motion_cut', 'fade'];
  if (intensity < 0.6) {
    return isBeatChange ? ['fade', 'cinematic', 'blur'] : ['fade', 'motion_cut', 'match_cut'];
  }
  return isBeatChange
    ? ['zoom', 'dynamic_swipe', 'cinematic', 'blur']
    : ['fade', 'zoom', 'speed_ramp', 'dynamic_swipe'];
}

/**
 * xfade consumes time from both clips, so the transition must be shorter than
 * either neighbour or the timeline drifts out of sync with the narration.
 */
function clampDuration(requested: number, context: TransitionContext): number {
  const ceiling = Math.min(context.previousDurationSec, context.nextDurationSec) * 0.4;
  return Number(Math.max(0.08, Math.min(requested, ceiling, 1.5)).toFixed(3));
}

/** Stable pseudo-random in [0,1) derived from the cut index. */
function hash(index: number): number {
  const x = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Ken Burns move for a still image, expressed as a `zoompan` filter.
 *
 * Camera motion is baked into the still whenever a motion clip was not
 * generated, so a "static image" project still reads as a moving picture.
 */
export function kenBurnsFilter(params: {
  motion: string;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  intensity?: number;
}): string {
  const frames = Math.max(1, Math.round(params.durationSec * params.fps));
  const amount = params.intensity ?? 0.12;
  // zoompan works on a supersampled source to avoid the shimmer its integer
  // pixel stepping otherwise produces.
  const superW = params.width * 2;
  const superH = params.height * 2;

  const zoomIn = `min(1+${amount}*on/${frames},${(1 + amount).toFixed(3)})`;
  const zoomOut = `max(${(1 + amount).toFixed(3)}-${amount}*on/${frames},1)`;

  let z = zoomIn;
  let x = 'iw/2-(iw/zoom/2)';
  let y = 'ih/2-(ih/zoom/2)';

  switch (params.motion) {
    case 'static':
      z = '1';
      break;
    case 'zoom_in':
    case 'push_in':
    case 'dolly_in':
      z = zoomIn;
      break;
    case 'zoom_out':
    case 'pull_out':
    case 'dolly_out':
      z = zoomOut;
      break;
    case 'pan_left':
      z = `${(1 + amount).toFixed(3)}`;
      x = `(iw-iw/zoom)*(1-on/${frames})`;
      break;
    case 'pan_right':
      z = `${(1 + amount).toFixed(3)}`;
      x = `(iw-iw/zoom)*(on/${frames})`;
      break;
    case 'tilt_up':
      z = `${(1 + amount).toFixed(3)}`;
      y = `(ih-ih/zoom)*(1-on/${frames})`;
      break;
    case 'tilt_down':
      z = `${(1 + amount).toFixed(3)}`;
      y = `(ih-ih/zoom)*(on/${frames})`;
      break;
    case 'orbit':
      z = zoomIn;
      x = `(iw-iw/zoom)/2+(iw-iw/zoom)/2*sin(2*PI*on/${frames})`;
      break;
    case 'handheld':
      z = `${(1 + amount / 2).toFixed(3)}`;
      x = `(iw-iw/zoom)/2+8*sin(2*PI*on/${Math.max(1, Math.round(params.fps * 1.7))})`;
      y = `(ih-ih/zoom)/2+6*sin(2*PI*on/${Math.max(1, Math.round(params.fps * 2.3))})`;
      break;
    default:
      z = zoomIn;
  }

  return [
    `scale=${superW}:${superH}:force_original_aspect_ratio=increase`,
    `crop=${superW}:${superH}`,
    `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${params.width}x${params.height}:fps=${params.fps}`,
    'setsar=1',
  ].join(',');
}
