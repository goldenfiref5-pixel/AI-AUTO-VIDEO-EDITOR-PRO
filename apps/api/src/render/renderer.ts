import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CaptionSettings,
  Dimensions,
  ExportFormat,
  ExportResolution,
  FrameRate,
  TranscriptWord,
  TransitionSettings,
} from '@aiedit/shared';
import { resolveDimensions } from '@aiedit/shared';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { buildAssFile, buildCues, buildSrtFile } from './captions';
import { probeMedia, runFfmpeg } from './ffmpeg';
import { kenBurnsFilter, resolveTransition, type ResolvedTransition } from './transitions';

export interface RenderScene {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  cameraMotion: string;
  emotion: string;
  location: string;
  transitionIn: string | null;
  /** Local path to a generated motion clip, if one exists. */
  clipPath: string | null;
  /** Local path to the still image; used when there is no clip. */
  imagePath: string | null;
}

export interface RenderRequest {
  projectId: string;
  scenes: RenderScene[];
  audioPath: string;
  words: TranscriptWord[];
  language: string;
  aspectRatio: '9:16' | '16:9' | '1:1';
  resolution: ExportResolution;
  format: ExportFormat;
  fps: FrameRate;
  videoBitrateKbps: number | null;
  audioBitrateKbps: number;
  caption: CaptionSettings;
  transition: TransitionSettings;
  workDir: string;
  /**
   * Where normalised scene clips are cached. Defaults to `workDir/scenes`, but
   * pointing it at a project-level directory lets a re-render skip scenes whose
   * source media and timing are unchanged.
   */
  sceneCacheDir?: string;
  outputPath: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
}

export interface RenderResult {
  outputPath: string;
  durationSec: number;
  bytes: number;
  width: number;
  height: number;
  subtitlePath: string | null;
  srtPath: string | null;
  /** Cuts that fell on a batch boundary and were rendered as hard cuts. */
  downgradedTransitions: number;
}

/**
 * Scenes per intermediate segment. A single filter graph holding every scene
 * would open 500 decoders at once; batching keeps memory flat and lets a failed
 * render resume from the last completed batch.
 */
const BATCH_SIZE = 40;

export async function renderProject(request: RenderRequest): Promise<RenderResult> {
  const canvas = resolveDimensions(request.aspectRatio, request.resolution);
  const sceneDir = request.sceneCacheDir ?? path.join(request.workDir, 'scenes');
  const batchDir = path.join(request.workDir, 'batches');
  await mkdir(sceneDir, { recursive: true });
  await mkdir(batchDir, { recursive: true });
  await mkdir(path.dirname(request.outputPath), { recursive: true });

  if (request.scenes.length === 0) {
    throw new Error('Cannot render a project with no scenes.');
  }

  const ordered = [...request.scenes].sort((a, b) => a.index - b.index);
  const durations = ordered.map((scene) => Math.max(0.2, scene.endSec - scene.startSec));

  // 1. Decide the transition for every cut up front, so clip lengths can
  //    include the tail each crossfade will consume.
  const transitions = planTransitions(ordered, durations, request.transition);
  const boundaries = planBatchBoundaries(ordered.length, transitions);
  const downgraded = countDowngrades(transitions, boundaries);

  // 2. Normalise every scene into a canvas-sized, constant-frame-rate clip.
  const clipPaths: string[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    throwIfAborted(request.signal);
    const scene = ordered[i]!;
    const tail = boundaries.has(i + 1) ? 0 : transitions[i]?.durationSec ?? 0;
    const clipLength = durations[i]! + tail;

    request.onProgress?.(
      0.05 + (i / ordered.length) * 0.55,
      `Preparing scene ${i + 1} of ${ordered.length}`,
    );

    clipPaths.push(
      await buildSceneClip({
        scene,
        durationSec: clipLength,
        canvas,
        fps: request.fps,
        outDir: sceneDir,
        signal: request.signal,
      }),
    );
  }

  // 3. Join scenes batch by batch, applying transitions inside each batch.
  const batchPaths: string[] = [];
  const batchRanges = toRanges(ordered.length, boundaries);

  for (let b = 0; b < batchRanges.length; b += 1) {
    throwIfAborted(request.signal);
    const [from, to] = batchRanges[b]!;
    request.onProgress?.(
      0.6 + (b / batchRanges.length) * 0.2,
      `Assembling segment ${b + 1} of ${batchRanges.length}`,
    );

    batchPaths.push(
      await joinBatch({
        clipPaths: clipPaths.slice(from, to),
        durations: durations.slice(from, to),
        transitions: transitions.slice(from, to - 1),
        canvas,
        fps: request.fps,
        outputPath: path.join(batchDir, `batch-${String(b).padStart(4, '0')}.mp4`),
        signal: request.signal,
      }),
    );
  }

  // 4. Concatenate the batches.
  throwIfAborted(request.signal);
  request.onProgress?.(0.82, 'Joining segments');
  const silentVideo =
    batchPaths.length === 1
      ? batchPaths[0]!
      : await concatFiles(batchPaths, path.join(request.workDir, 'timeline.mp4'), request.signal);

  // 5. Burn captions and mux the narration.
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);
  let subtitlePath: string | null = null;
  let srtPath: string | null = null;

  if (request.caption.enabled && request.words.length > 0) {
    const cues = buildCues(request.words, request.caption);
    subtitlePath = path.join(request.workDir, 'captions.ass');
    srtPath = path.join(request.workDir, 'captions.srt');
    await writeFile(subtitlePath, buildAssFile(cues, {
      settings: request.caption,
      canvas,
      language: request.language,
    }), 'utf8');
    await writeFile(srtPath, buildSrtFile(cues), 'utf8');
  }

  request.onProgress?.(0.85, 'Burning captions and mixing narration');
  await finalMux({
    videoPath: silentVideo,
    audioPath: request.audioPath,
    subtitlePath,
    outputPath: request.outputPath,
    canvas,
    fps: request.fps,
    format: request.format,
    videoBitrateKbps: request.videoBitrateKbps,
    audioBitrateKbps: request.audioBitrateKbps,
    durationSec: totalDuration,
    signal: request.signal,
    onProgress: (fraction) =>
      request.onProgress?.(0.85 + fraction * 0.14, 'Encoding final video'),
  });

  const info = await probeMedia(request.outputPath);
  const fileInfo = await stat(request.outputPath);
  request.onProgress?.(1, 'Render complete');

  return {
    outputPath: request.outputPath,
    durationSec: info.durationSec,
    bytes: fileInfo.size,
    width: canvas.width,
    height: canvas.height,
    subtitlePath,
    srtPath,
    downgradedTransitions: downgraded,
  };
}

function planTransitions(
  scenes: readonly RenderScene[],
  durations: readonly number[],
  settings: TransitionSettings,
): ResolvedTransition[] {
  const result: ResolvedTransition[] = [];
  for (let i = 0; i < scenes.length - 1; i += 1) {
    const current = scenes[i]!;
    const next = scenes[i + 1]!;
    result.push(
      resolveTransition(settings, {
        index: i,
        previousDurationSec: durations[i]!,
        nextDurationSec: durations[i + 1]!,
        isBeatChange: current.location !== next.location || current.emotion !== next.emotion,
        requested: (next.transitionIn as ResolvedTransition['type'] | null) ?? null,
      }),
    );
  }
  return result;
}

/**
 * Choose batch split points, preferring cuts that are already hard so a
 * stylised transition is not lost at a boundary.
 */
function planBatchBoundaries(
  sceneCount: number,
  transitions: readonly ResolvedTransition[],
): Set<number> {
  const boundaries = new Set<number>();
  if (sceneCount <= BATCH_SIZE) return boundaries;

  let cursor = BATCH_SIZE;
  while (cursor < sceneCount) {
    // Search backwards up to 8 scenes for an existing hard cut.
    let chosen = cursor;
    for (let offset = 0; offset < 8 && cursor - offset > 1; offset += 1) {
      const candidate = cursor - offset;
      if (!transitions[candidate - 1]?.xfade) {
        chosen = candidate;
        break;
      }
    }
    boundaries.add(chosen);
    cursor = chosen + BATCH_SIZE;
  }
  return boundaries;
}

function countDowngrades(
  transitions: readonly ResolvedTransition[],
  boundaries: ReadonlySet<number>,
): number {
  let count = 0;
  for (const boundary of boundaries) {
    if (transitions[boundary - 1]?.xfade) count += 1;
  }
  return count;
}

function toRanges(sceneCount: number, boundaries: ReadonlySet<number>): Array<[number, number]> {
  const points = [0, ...[...boundaries].sort((a, b) => a - b), sceneCount];
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    if (to > from) ranges.push([from, to]);
  }
  return ranges;
}

interface SceneClipParams {
  scene: RenderScene;
  durationSec: number;
  canvas: Dimensions;
  fps: FrameRate;
  outDir: string;
  signal?: AbortSignal;
}

/**
 * Turn one scene into a silent, canvas-sized clip of exactly `durationSec`.
 *
 * Output is content-addressed: a re-render that has not changed the scene reuses
 * the existing file, which is what makes an interrupted render resumable.
 */
async function buildSceneClip(params: SceneClipParams): Promise<string> {
  const { scene, canvas, fps } = params;
  const signature = createHash('sha1')
    .update(
      JSON.stringify([
        scene.id,
        scene.clipPath,
        scene.imagePath,
        scene.cameraMotion,
        params.durationSec.toFixed(3),
        canvas.width,
        canvas.height,
        fps,
      ]),
    )
    .digest('hex')
    .slice(0, 16);

  const outputPath = path.join(params.outDir, `scene-${String(scene.index).padStart(4, '0')}-${signature}.mp4`);

  try {
    const existing = await stat(outputPath);
    if (existing.size > 1024) {
      logger.debug({ sceneId: scene.id }, 'Reusing cached scene clip');
      return outputPath;
    }
  } catch {
    // not cached yet
  }

  const commonOut = [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-an',
    '-movflags', '+faststart',
    outputPath,
  ];

  if (scene.clipPath) {
    const info = await probeMedia(scene.clipPath).catch(() => null);
    const sourceDuration = info?.durationSec ?? 0;

    // The generated clip rarely matches the narration slice exactly. Shorter
    // clips are slowed to fit rather than frozen; longer ones are trimmed.
    const speed =
      sourceDuration > 0.2 ? clamp(sourceDuration / params.durationSec, 0.5, 2.0) : 1;

    const filters = [
      speed !== 1 ? `setpts=${(1 / speed).toFixed(6)}*PTS` : null,
      `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase`,
      `crop=${canvas.width}:${canvas.height}`,
      `fps=${fps}`,
      'setsar=1',
      // Freeze the last frame if the clip still falls short after retiming.
      `tpad=stop_mode=clone:stop_duration=${Math.max(0, params.durationSec).toFixed(3)}`,
      `trim=duration=${params.durationSec.toFixed(3)}`,
      'setpts=PTS-STARTPTS',
    ].filter(Boolean) as string[];

    await runFfmpeg({
      args: ['-i', scene.clipPath, '-vf', filters.join(','), '-t', params.durationSec.toFixed(3), ...commonOut],
      timeoutMs: 15 * 60_000,
      signal: params.signal,
    });
    return outputPath;
  }

  if (scene.imagePath) {
    const filter = kenBurnsFilter({
      motion: scene.cameraMotion,
      durationSec: params.durationSec,
      fps,
      width: canvas.width,
      height: canvas.height,
    });

    await runFfmpeg({
      args: [
        '-loop', '1',
        '-i', scene.imagePath,
        '-vf', filter,
        '-t', params.durationSec.toFixed(3),
        ...commonOut,
      ],
      timeoutMs: 15 * 60_000,
      signal: params.signal,
    });
    return outputPath;
  }

  // Neither a clip nor an image survived generation. Render a neutral slate so
  // the timeline stays intact and the gap is visible rather than fatal.
  await runFfmpeg({
    args: [
      '-f', 'lavfi',
      '-i', `color=c=0x101418:s=${canvas.width}x${canvas.height}:r=${fps}:d=${params.durationSec.toFixed(3)}`,
      '-vf', 'noise=alls=6:allf=t+u',
      '-t', params.durationSec.toFixed(3),
      ...commonOut,
    ],
    timeoutMs: 5 * 60_000,
    signal: params.signal,
  });
  return outputPath;
}

interface JoinBatchParams {
  clipPaths: string[];
  durations: number[];
  transitions: ResolvedTransition[];
  canvas: Dimensions;
  fps: FrameRate;
  outputPath: string;
  signal?: AbortSignal;
}

/**
 * Join one batch of scene clips, blending with `xfade` where a transition was
 * chosen and concatenating where the cut is hard.
 */
async function joinBatch(params: JoinBatchParams): Promise<string> {
  const { clipPaths, durations, transitions } = params;

  if (clipPaths.length === 1) return clipPaths[0]!;

  const hasBlend = transitions.some((t) => t.xfade);
  if (!hasBlend) {
    return concatFiles(clipPaths, params.outputPath, params.signal);
  }

  const inputs = clipPaths.flatMap((clip) => ['-i', clip]);
  const filters: string[] = [];

  // Normalise every input before blending; xfade requires identical formats.
  clipPaths.forEach((_, i) => {
    filters.push(`[${i}:v]format=pix_fmts=yuv420p,fps=${params.fps},setsar=1,settb=AVTB[v${i}]`);
  });

  let current = 'v0';
  // Offsets accumulate on-screen durations, so the timeline stays exactly in
  // step with the narration even though xfade shortens the concatenation.
  let offset = 0;

  for (let i = 1; i < clipPaths.length; i += 1) {
    const transition = transitions[i - 1];
    const label = i === clipPaths.length - 1 ? 'out' : `x${i}`;
    offset += durations[i - 1]!;

    if (transition?.xfade) {
      filters.push(
        `[${current}][v${i}]xfade=transition=${transition.xfade}:duration=${transition.durationSec.toFixed(
          3,
        )}:offset=${offset.toFixed(3)}[${label}]`,
      );
    } else {
      filters.push(`[${current}][v${i}]concat=n=2:v=1:a=0[${label}]`);
    }
    current = label;
  }

  await runFfmpeg({
    args: [
      ...inputs,
      '-filter_complex', filters.join(';'),
      '-map', '[out]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-r', String(params.fps),
      '-an',
      params.outputPath,
    ],
    timeoutMs: 60 * 60_000,
    signal: params.signal,
  });

  return params.outputPath;
}

/** Stream-copy concatenation via the demuxer — no re-encode, so it is fast. */
async function concatFiles(
  files: string[],
  outputPath: string,
  signal?: AbortSignal,
): Promise<string> {
  if (files.length === 1) return files[0]!;

  const listPath = `${outputPath}.txt`;
  await writeFile(
    listPath,
    files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8',
  );

  await runFfmpeg({
    args: ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath],
    timeoutMs: 30 * 60_000,
    signal,
  });

  await rm(listPath, { force: true }).catch(() => undefined);
  return outputPath;
}

interface FinalMuxParams {
  videoPath: string;
  audioPath: string;
  subtitlePath: string | null;
  outputPath: string;
  canvas: Dimensions;
  fps: FrameRate;
  format: ExportFormat;
  videoBitrateKbps: number | null;
  audioBitrateKbps: number;
  durationSec: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Codec selection per container. */
function codecArgs(format: ExportFormat, videoBitrateKbps: number | null, audioBitrateKbps: number): string[] {
  const rate = videoBitrateKbps ? ['-b:v', `${videoBitrateKbps}k`, '-maxrate', `${Math.round(videoBitrateKbps * 1.5)}k`, '-bufsize', `${videoBitrateKbps * 2}k`] : ['-crf', '19'];

  if (format === 'webm') {
    return [
      '-c:v', 'libvpx-vp9',
      '-row-mt', '1',
      '-deadline', 'good',
      '-cpu-used', '2',
      ...(videoBitrateKbps ? ['-b:v', `${videoBitrateKbps}k`] : ['-crf', '31', '-b:v', '0']),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus',
      '-b:a', `${audioBitrateKbps}k`,
    ];
  }

  // mp4 and mov both take H.264 + AAC; mov additionally gets faststart so it
  // streams as readily as the mp4.
  return [
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-profile:v', 'high',
    '-level', '4.2',
    ...rate,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    '-ar', '48000',
  ];
}

async function finalMux(params: FinalMuxParams): Promise<void> {
  const filters: string[] = [
    `scale=${params.canvas.width}:${params.canvas.height}:force_original_aspect_ratio=decrease`,
    `pad=${params.canvas.width}:${params.canvas.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
  ];

  if (params.subtitlePath) {
    // libass reads the file directly; the path is escaped for the filter parser.
    filters.push(`subtitles=filename='${escapeFilterPath(params.subtitlePath)}'`);
  }

  const args = [
    '-i', params.videoPath,
    '-i', params.audioPath,
    '-filter_complex', `[0:v]${filters.join(',')}[v]`,
    '-map', '[v]',
    '-map', '1:a:0',
    '-t', params.durationSec.toFixed(3),
    '-r', String(params.fps),
    ...codecArgs(params.format, params.videoBitrateKbps, params.audioBitrateKbps),
    ...(params.format === 'mp4' || params.format === 'mov' ? ['-movflags', '+faststart'] : []),
    params.outputPath,
  ];

  await runFfmpeg({
    args,
    timeoutMs: 6 * 60 * 60_000,
    signal: params.signal,
    onStderr: (line) => {
      const match = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (!match || !params.onProgress) return;
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      params.onProgress(Math.min(1, seconds / Math.max(1, params.durationSec)));
    },
  });
}

/**
 * FFmpeg's filter parser needs `:`, `'` and `\` escaped inside filter
 * arguments, and Windows drive letters escaped twice.
 */
function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Render cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

/** Working directory for one render attempt. */
export function renderWorkDir(projectId: string, renderId: string): string {
  return path.join(path.resolve(env.RENDER_TMP_DIR), projectId, renderId);
}

/** Project-level scene clip cache, shared across render attempts. */
export function sceneCacheDir(projectId: string): string {
  return path.join(path.resolve(env.RENDER_TMP_DIR), projectId, 'scene-cache');
}
