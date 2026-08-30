import { spawn } from 'node:child_process';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { badRequest, serverError } from '../utils/errors';

export interface RunOptions {
  args: string[];
  /** Called with FFmpeg's stderr lines so callers can surface progress. */
  onStderr?: (line: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Run a binary, buffering stderr for diagnostics; rejects on a non-zero exit. */
function run(bin: string, options: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, options.args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderrTail: string[] = [];
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          finish(new Error(`${bin} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : undefined;

    const onAbort = () => {
      child.kill('SIGKILL');
      finish(new Error(`${bin} was cancelled`));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    function finish(err: Error | null, value = '') {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    let buffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        options.onStderr?.(line);
        // Keep only the tail: FFmpeg's stderr is enormous but the failure
        // reason is always at the end.
        stderrTail.push(line);
        if (stderrTail.length > 60) stderrTail = stderrTail.slice(-60);
      }
    });

    child.on('error', (err) => {
      finish(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(
              `${bin} was not found. Install FFmpeg or set FFMPEG_PATH / FFPROBE_PATH to its location.`,
            )
          : err,
      );
    });

    child.on('close', (code) => {
      if (code === 0) finish(null, stdout);
      else finish(new Error(`${bin} exited with code ${code}\n${stderrTail.join('\n')}`));
    });
  });
}

export function runFfmpeg(options: RunOptions): Promise<string> {
  logger.debug({ args: options.args.join(' ').slice(0, 800) }, 'ffmpeg');
  return run(env.FFMPEG_PATH, { ...options, args: ['-hide_banner', '-y', ...options.args] });
}

export function runFfprobe(args: string[]): Promise<string> {
  return run(env.FFPROBE_PATH, { args, timeoutMs: 120_000 });
}

export interface MediaInfo {
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  audioChannels: number | null;
  sampleRate: number | null;
  bitrate: number | null;
  formatName: string;
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  duration?: string;
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value || value === '0/0') return null;
  const [num, den] = value.split('/').map(Number);
  if (!num || !den) return null;
  return Number((num / den).toFixed(3));
}

export async function probeMedia(filePath: string): Promise<MediaInfo> {
  let raw: string;
  try {
    raw = await runFfprobe([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
  } catch (err) {
    throw badRequest(
      `Could not read this media file — it may be corrupt or in an unsupported format. (${
        err instanceof Error ? err.message.split('\n')[0] : String(err)
      })`,
    );
  }

  let parsed: { streams?: ProbeStream[]; format?: Record<string, string> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw serverError('ffprobe returned malformed JSON');
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  const durationSec = Number(parsed.format?.['duration'] ?? video?.duration ?? audio?.duration ?? 0);

  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseFrameRate(video?.avg_frame_rate),
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    audioChannels: audio?.channels ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    bitrate: parsed.format?.['bit_rate'] ? Number(parsed.format['bit_rate']) : null,
    formatName: parsed.format?.['format_name'] ?? 'unknown',
  };
}

/** Normalise arbitrary uploaded audio to 16 kHz mono FLAC for transcription. */
export async function toTranscriptionAudio(inputPath: string, outputPath: string): Promise<string> {
  await runFfmpeg({
    args: [
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'flac',
      '-compression_level', '5',
      outputPath,
    ],
    timeoutMs: 30 * 60_000,
  });
  return outputPath;
}

/** Extract a single frame as a JPEG — used to sample competitor videos. */
export async function extractFrame(
  inputPath: string,
  atSec: number,
  outputPath: string,
  width = 640,
): Promise<string> {
  await runFfmpeg({
    args: [
      '-ss', atSec.toFixed(3),
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', '4',
      outputPath,
    ],
    timeoutMs: 120_000,
  });
  return outputPath;
}

/**
 * Downscale and strip audio from a competitor video so the analysis upload
 * stays small — Gemini only needs the visual grammar.
 */
export async function compressForAnalysis(
  inputPath: string,
  outputPath: string,
  maxSeconds = 180,
): Promise<string> {
  await runFfmpeg({
    args: [
      '-i', inputPath,
      '-t', String(maxSeconds),
      '-an',
      '-vf', 'scale=-2:480,fps=8',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '32',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath,
    ],
    timeoutMs: 20 * 60_000,
  });
  return outputPath;
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(env.FFMPEG_PATH, { args: ['-version'], timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}
