import type { GenerateRequestInput, Job, JobType, Project, RenderRequestInput } from '@aiedit/shared';
import { logger } from '../config/logger';
import { badRequest, conflict } from '../utils/errors';
import { createJob, attachQueueJob, listProjectJobs } from './jobs';
import { enqueue } from '../queue/queues';
import { listScenes } from './scenes';
import { getTranscript } from './transcripts';
import { createRenderRecord, attachRenderJob } from './renders';
import { listProjectAssets } from './assets';

/** Job types that must not run twice concurrently for one project. */
const EXCLUSIVE: JobType[] = ['transcribe', 'story_analysis', 'render'];

const ACTIVE_STATUSES = new Set(['pending', 'processing', 'generating_images', 'generating_video', 'rendering']);

async function assertNotAlreadyRunning(projectId: string, type: JobType): Promise<void> {
  if (!EXCLUSIVE.includes(type)) return;
  const jobs = await listProjectJobs(projectId);
  const running = jobs.find((job) => job.type === type && ACTIVE_STATUSES.has(job.status));
  if (running) {
    throw conflict(`A ${type.replace('_', ' ')} job is already running for this project.`, {
      jobId: running.id,
    });
  }
}

export interface StartJobOptions {
  priority?: number;
  payload?: Record<string, unknown>;
}

async function startJob(
  project: Project,
  type: JobType,
  options: StartJobOptions = {},
): Promise<Job> {
  await assertNotAlreadyRunning(project.id, type);

  const job = await createJob({
    projectId: project.id,
    userId: project.userId,
    type,
    priority: options.priority,
    payload: options.payload,
  });

  const queueJobId = await enqueue(
    { jobId: job.id, projectId: project.id, userId: project.userId, type, ...(options.payload ?? {}) },
    { priority: options.priority },
  );
  await attachQueueJob(job.id, queueJobId);

  return job;
}

/** Kick off transcription right after the voiceover upload. */
export async function startTranscription(project: Project, assetId: string): Promise<Job> {
  return startJob(project, 'transcribe', { payload: { assetId }, priority: 5 });
}

export async function startReferenceAnalysis(project: Project): Promise<Job> {
  return startJob(project, 'analyze_references', { priority: 8 });
}

/**
 * The "Proceed To Video Generation" action: analyse references if needed, then
 * plan the storyboard. Generation itself waits for storyboard approval.
 */
export async function startStoryAnalysis(project: Project): Promise<Job[]> {
  const transcript = await getTranscript(project.id);
  if (!transcript) throw badRequest('Upload and transcribe a voiceover first.');
  if (!transcript.approvedAt) throw badRequest('Approve the transcript before planning scenes.');

  const jobs: Job[] = [];

  // References are analysed first so the story planner can use the pacing
  // profile and Style DNA summary.
  const styleAssets = await listProjectAssets(project.id, 'style_reference');
  const videoAssets = await listProjectAssets(project.id, 'competitor_video');
  if (styleAssets.length > 0 || videoAssets.length > 0) {
    jobs.push(await startReferenceAnalysis(project));
  }

  jobs.push(await startStoryJobAfterReferences(project, jobs[0]?.id ?? null));
  return jobs;
}

async function startStoryJobAfterReferences(project: Project, dependsOn: string | null): Promise<Job> {
  return startJob(project, 'story_analysis', {
    priority: 9,
    payload: dependsOn ? { dependsOn } : {},
  });
}

/** Storyboard approved: generate images, then motion clips. */
export async function startGeneration(
  project: Project,
  input: GenerateRequestInput,
): Promise<Job[]> {
  const scenes = await listScenes(project.id);
  if (scenes.length === 0) throw badRequest('Plan the storyboard before generating visuals.');

  const payload = {
    force: input.force,
    ...(input.sceneIds?.length ? { sceneIds: input.sceneIds } : {}),
  };

  const imageJob = await startJob(project, 'generate_images', {
    priority: input.priority ?? 10,
    payload,
  });

  const clipJob = await startJob(project, 'generate_clips', {
    priority: (input.priority ?? 10) + 1,
    payload: { ...payload, dependsOn: imageJob.id },
  });

  return [imageJob, clipJob];
}

export async function startRender(
  project: Project,
  input: RenderRequestInput,
): Promise<{ job: Job; renderId: string }> {
  const scenes = await listScenes(project.id);
  if (scenes.length === 0) throw badRequest('There is nothing to render — plan the storyboard first.');

  const withMedia = scenes.filter((s) => s.imageAssetId || s.clipAssetId).length;
  if (withMedia === 0) {
    throw badRequest('No scene has generated media yet. Run image generation before rendering.');
  }

  const record = await createRenderRecord({
    projectId: project.id,
    format: input.format ?? project.settings.export.format,
    resolution: input.resolution ?? project.settings.export.resolution,
    fps: input.fps ?? project.settings.export.fps,
  });

  const job = await startJob(project, 'render', {
    priority: input.priority ?? 12,
    payload: { renderId: record.id },
  });

  await attachRenderJob(record.id, job.id);
  logger.info({ projectId: project.id, renderId: record.id, jobId: job.id }, 'Render queued');

  return { job, renderId: record.id };
}

/** Re-queue a failed or cancelled job with its original payload. */
export async function requeueJob(job: Job): Promise<string> {
  const queueJobId = await enqueue(
    {
      jobId: job.id,
      projectId: job.projectId,
      userId: job.userId,
      type: job.type,
      ...job.payload,
    },
    { priority: job.priority },
  );
  await attachQueueJob(job.id, queueJobId);
  return queueJobId;
}
