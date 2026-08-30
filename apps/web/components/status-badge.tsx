import type { JobStatus, ProjectStatus } from '@aiedit/shared';
import { Badge, type BadgeTone } from './ui/primitives';

const PROJECT_TONES: Record<ProjectStatus, BadgeTone> = {
  draft: 'neutral',
  transcribing: 'brand',
  transcript_ready: 'accent',
  analyzing: 'brand',
  storyboard_ready: 'accent',
  generating: 'brand',
  rendering: 'brand',
  completed: 'ok',
  failed: 'danger',
};

const PROJECT_LABELS: Record<ProjectStatus, string> = {
  draft: 'Draft',
  transcribing: 'Transcribing',
  transcript_ready: 'Transcript ready',
  analyzing: 'Analysing story',
  storyboard_ready: 'Storyboard ready',
  generating: 'Generating',
  rendering: 'Rendering',
  completed: 'Completed',
  failed: 'Failed',
};

const JOB_TONES: Record<JobStatus, BadgeTone> = {
  pending: 'neutral',
  processing: 'brand',
  generating_images: 'brand',
  generating_video: 'brand',
  rendering: 'brand',
  completed: 'ok',
  failed: 'danger',
  cancelled: 'warn',
};

const JOB_LABELS: Record<JobStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  generating_images: 'Generating images',
  generating_video: 'Generating video',
  rendering: 'Rendering',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const ACTIVE: ReadonlySet<string> = new Set([
  'transcribing',
  'analyzing',
  'generating',
  'rendering',
  'processing',
  'generating_images',
  'generating_video',
  'pending',
]);

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <Badge tone={PROJECT_TONES[status]}>
      {ACTIVE.has(status) ? <PulseDot /> : null}
      {PROJECT_LABELS[status]}
    </Badge>
  );
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return (
    <Badge tone={JOB_TONES[status]}>
      {ACTIVE.has(status) ? <PulseDot /> : null}
      {JOB_LABELS[status]}
    </Badge>
  );
}

function PulseDot() {
  return (
    <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-70" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  );
}
