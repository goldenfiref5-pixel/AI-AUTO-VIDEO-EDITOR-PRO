import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captionPreset, type TranscriptWord } from '@aiedit/shared';
import { env } from '../config/env';
import { probeMedia, runFfmpeg } from '../render/ffmpeg';
import { renderProject, type RenderScene } from '../render/renderer';

/**
 * End-to-end render test against real FFmpeg.
 *
 * It builds synthetic scene media and narration, renders a full project, and
 * asserts the invariant the whole pipeline rests on: the finished video is
 * exactly as long as the narration it was cut to.
 *
 * Skipped automatically where FFmpeg is not installed.
 */
// Probed synchronously so the suite can be skipped at collection time; the
// async `ffmpegAvailable` helper would need a top-level await.
const hasFfmpeg = spawnSync(env.FFMPEG_PATH, ['-version'], { stdio: 'ignore' }).status === 0;
const describeRender = hasFfmpeg ? describe : describe.skip;

let workDir = '';

async function makeImage(dir: string, name: string, color: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await runFfmpeg({
    args: ['-f', 'lavfi', '-i', `color=c=${color}:s=540x960`, '-frames:v', '1', filePath],
    timeoutMs: 60_000,
  });
  return filePath;
}

async function makeClip(dir: string, name: string, durationSec: number): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await runFfmpeg({
    args: [
      '-f', 'lavfi',
      '-i', `testsrc=size=540x960:rate=24:duration=${durationSec}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-t', String(durationSec),
      filePath,
    ],
    timeoutMs: 120_000,
  });
  return filePath;
}

async function makeAudio(dir: string, name: string, durationSec: number): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await runFfmpeg({
    args: [
      '-f', 'lavfi',
      '-i', `sine=frequency=440:duration=${durationSec}`,
      '-ac', '1',
      '-ar', '48000',
      filePath,
    ],
    timeoutMs: 60_000,
  });
  return filePath;
}

function words(): TranscriptWord[] {
  // Six words spread evenly across six seconds.
  return Array.from({ length: 6 }, (_, i) => ({
    text: ['Once', 'upon', 'a', 'time', 'there', 'was'][i]!,
    start: i,
    end: i + 0.9,
  }));
}

describeRender('renderProject', () => {
  beforeAll(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'aiedit-render-test-'));
  }, 120_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('renders a project whose duration matches the narration exactly', async () => {
    const mediaDir = path.join(workDir, 'media');
    const outputPath = path.join(workDir, 'out.mp4');

    const [imageA, imageB, clip, audio] = await Promise.all([
      makeImage(mediaDir, 'a.png', 'navy'),
      makeImage(mediaDir, 'b.png', 'maroon'),
      makeClip(mediaDir, 'c.mp4', 2),
      makeAudio(mediaDir, 'narration.wav', 6),
    ]);

    const scenes: RenderScene[] = [
      {
        id: 's1',
        index: 0,
        startSec: 0,
        endSec: 2,
        cameraMotion: 'push_in',
        emotion: 'curious',
        location: 'village',
        transitionIn: null,
        clipPath: null,
        imagePath: imageA,
      },
      {
        id: 's2',
        index: 1,
        startSec: 2,
        endSec: 4,
        cameraMotion: 'pan_right',
        emotion: 'excited',
        // A different location makes this a beat change, which the transition
        // engine treats as a candidate for a stylised cut.
        location: 'bedroom',
        transitionIn: 'fade',
        clipPath: null,
        imagePath: imageB,
      },
      {
        id: 's3',
        index: 2,
        startSec: 4,
        endSec: 6,
        cameraMotion: 'static',
        emotion: 'excited',
        location: 'bedroom',
        transitionIn: null,
        // Exercises the motion-clip path, including retiming to fit the slot.
        clipPath: clip,
        imagePath: imageA,
      },
    ];

    const result = await renderProject({
      projectId: 'test-project',
      scenes,
      audioPath: audio,
      words: words(),
      language: 'en',
      aspectRatio: '9:16',
      resolution: '720p',
      format: 'mp4',
      fps: 24,
      videoBitrateKbps: null,
      audioBitrateKbps: 128,
      caption: { ...captionPreset('tiktok'), fontSize: 48 },
      transition: { enabled: true, types: ['fade'], intensity: 1, durationSec: 0.3 },
      workDir: path.join(workDir, 'work'),
      outputPath,
    });

    const info = await probeMedia(outputPath);
    const fileInfo = await stat(outputPath);

    expect(fileInfo.size).toBeGreaterThan(10_000);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);

    // The whole design rests on this: the render is as long as the narration.
    expect(info.durationSec).toBeGreaterThan(5.8);
    expect(info.durationSec).toBeLessThan(6.3);

    // 720p on a 9:16 canvas means the long edge is 1280.
    expect(result.width).toBe(720);
    expect(result.height).toBe(1280);
    expect(info.width).toBe(720);
    expect(info.height).toBe(1280);
    expect(info.fps).toBeCloseTo(24, 0);

    // Captions were generated and burned in.
    expect(result.subtitlePath).not.toBeNull();
    const ass = await readFile(result.subtitlePath!, 'utf8');
    expect(ass).toContain('PlayResX: 720');
    expect(ass).toContain('Dialogue: 0,');
  }, 600_000);

  it('reuses cached scene clips on a second render', async () => {
    const mediaDir = path.join(workDir, 'media2');
    const cacheDir = path.join(workDir, 'scene-cache');

    const [image, audio] = await Promise.all([
      makeImage(mediaDir, 'a.png', 'darkgreen'),
      makeAudio(mediaDir, 'narration.wav', 2),
    ]);

    const scenes: RenderScene[] = [
      {
        id: 'cached-1',
        index: 0,
        startSec: 0,
        endSec: 2,
        cameraMotion: 'zoom_in',
        emotion: '',
        location: '',
        transitionIn: null,
        clipPath: null,
        imagePath: image,
      },
    ];

    const request = (suffix: string) => ({
      projectId: 'cache-project',
      scenes,
      audioPath: audio,
      words: [{ text: 'hello', start: 0, end: 1 }],
      language: 'en',
      aspectRatio: '9:16' as const,
      resolution: '720p' as const,
      format: 'mp4' as const,
      fps: 24 as const,
      videoBitrateKbps: null,
      audioBitrateKbps: 128,
      caption: { ...captionPreset('minimal'), enabled: false },
      transition: { enabled: false, types: [], intensity: 0, durationSec: 0.3 },
      workDir: path.join(workDir, `work-${suffix}`),
      sceneCacheDir: cacheDir,
      outputPath: path.join(workDir, `cached-${suffix}.mp4`),
    });

    await renderProject(request('first'));
    const cachedFile = path.join(cacheDir, (await readdir(cacheDir))[0]!);
    const firstMtime = (await stat(cachedFile)).mtimeMs;

    await renderProject(request('second'));
    const secondMtime = (await stat(cachedFile)).mtimeMs;

    // An unchanged scene must not be re-encoded.
    expect(secondMtime).toBe(firstMtime);
  }, 600_000);
});
