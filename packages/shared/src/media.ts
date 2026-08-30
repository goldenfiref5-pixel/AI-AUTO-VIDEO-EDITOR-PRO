import type { AspectRatio, ExportResolution, ImageResolution } from './enums';

export interface Dimensions {
  width: number;
  height: number;
}

/** Long edge in pixels for each named export resolution. */
const LONG_EDGE: Record<ExportResolution, number> = {
  '720p': 1280,
  '1080p': 1920,
  '1440p': 2560,
  '4k': 3840,
};

/** Even dimensions keep libx264/libvpx happy (yuv420p requires mod-2). */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function aspectRatioValue(ratio: AspectRatio): number {
  const [w, h] = ratio.split(':').map(Number) as [number, number];
  return w / h;
}

/**
 * Resolve the pixel canvas for a project. The named resolution always applies
 * to the *long* edge, so 1080p vertical is 1080x1920 and 1080p landscape is
 * 1920x1080.
 */
export function resolveDimensions(ratio: AspectRatio, resolution: ExportResolution): Dimensions {
  const long = LONG_EDGE[resolution];
  const value = aspectRatioValue(ratio);
  if (value > 1) return { width: even(long), height: even(long / value) };
  if (value < 1) return { width: even(long * value), height: even(long) };
  // Square: the "long edge" is the short edge too, but 4K square at 3840 is
  // wasteful, so square uses the height component of the landscape canvas.
  const side = even(long / (16 / 9));
  return { width: side, height: side };
}

/** Closest supported generation resolution for a target aspect ratio. */
export function imageResolutionFor(ratio: AspectRatio): ImageResolution {
  switch (ratio) {
    case '9:16':
      return '1080x1920';
    case '16:9':
      return '1920x1080';
    case '1:1':
    default:
      return '1024x1024';
  }
}

export function parseImageResolution(resolution: ImageResolution): Dimensions {
  const [width, height] = resolution.split('x').map(Number) as [number, number];
  return { width, height };
}

/** `01:23.450` style stamp used in the transcript UI. */
export function formatTimestamp(seconds: number, withMillis = false): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  const base =
    hrs > 0
      ? `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return withMillis ? `${base}.${String(millis).padStart(3, '0')}` : base;
}

/** ASS subtitle stamps are centisecond precision: `H:MM:SS.cc`. */
export function formatAssTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** `00:00:05,250` — SRT stamps use a comma and millisecond precision. */
export function formatSrtTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
}
