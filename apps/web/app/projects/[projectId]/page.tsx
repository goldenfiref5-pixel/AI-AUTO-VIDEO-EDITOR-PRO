'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { PageHeader } from '@/components/page-header';
import { JobStatusBadge, ProjectStatusBadge } from '@/components/status-badge';
import { CharactersPanel } from '@/components/project/characters-panel';
import { ExportPanel } from '@/components/project/export-panel';
import { ReferencesPanel } from '@/components/project/references-panel';
import { SettingsPanel } from '@/components/project/settings-panel';
import { Storyboard } from '@/components/project/storyboard';
import { TimelineEditor } from '@/components/project/timeline';
import { TranscriptReview } from '@/components/project/transcript-review';
import { UploadStep } from '@/components/project/upload-step';
import { Button } from '@/components/ui/button';
import { Badge, ProgressBar, Skeleton } from '@/components/ui/primitives';
import { clock, cn } from '@/lib/utils';
import { currentStep, useProject, type ProjectBundle } from '@/lib/use-project';

type TabId =
  | 'voiceover'
  | 'transcript'
  | 'references'
  | 'storyboard'
  | 'characters'
  | 'timeline'
  | 'settings'
  | 'export';

interface Tab {
  id: TabId;
  label: string;
  /** Returns null when the tab is available, or why it is not. */
  blockedBy: (bundle: ProjectBundle) => string | null;
}

const TABS: Tab[] = [
  { id: 'voiceover', label: 'Voiceover', blockedBy: () => null },
  {
    id: 'transcript',
    label: 'Transcript',
    blockedBy: (b) => (b.transcript ? null : 'Upload a voiceover first'),
  },
  { id: 'references', label: 'References', blockedBy: () => null },
  {
    id: 'storyboard',
    label: 'Storyboard',
    blockedBy: (b) => (b.transcript?.approvedAt ? null : 'Approve the transcript first'),
  },
  {
    id: 'characters',
    label: 'Characters',
    blockedBy: (b) => (b.characters.length > 0 ? null : 'Characters appear after story analysis'),
  },
  {
    id: 'timeline',
    label: 'Timeline',
    blockedBy: (b) => (b.scenes.length > 0 ? null : 'Plan a storyboard first'),
  },
  { id: 'settings', label: 'Captions & export settings', blockedBy: () => null },
  {
    id: 'export',
    label: 'Export',
    blockedBy: (b) => (b.scenes.length > 0 ? null : 'Nothing to export yet'),
  },
];

export default function ProjectPage() {
  return (
    <AppShell>
      <ProjectWorkspace />
    </AppShell>
  );
}

function ProjectWorkspace() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { data, loading, error, progress, reload } = useProject(projectId);
  const [tab, setTab] = useState<TabId | null>(null);

  // Until the user picks a tab, follow the pipeline's own position.
  const activeTab: TabId = useMemo(() => {
    if (tab) return tab;
    switch (currentStep(data)) {
      case 'upload':
        return 'voiceover';
      case 'transcript':
        return 'transcript';
      case 'storyboard':
      case 'generate':
        return 'storyboard';
      case 'export':
        return 'export';
      default:
        return 'voiceover';
    }
  }, [tab, data]);

  if (loading && !data) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-16" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <div className="card p-6 text-center">
          <p className="text-sm text-danger">{error ?? 'Project not found.'}</p>
          <Link href="/dashboard">
            <Button variant="secondary" className="mt-3">
              Back to projects
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const activeJob = data.jobs.find((job) =>
    ['pending', 'processing', 'generating_images', 'generating_video', 'rendering'].includes(job.status),
  );

  return (
    <>
      <PageHeader
        title={data.project.name}
        description={data.project.videoTitle ?? undefined}
        breadcrumb={
          <Link href="/dashboard" className="hover:text-ink">
            Projects
          </Link>
        }
        actions={
          <>
            <ProjectStatusBadge status={data.project.status} />
            <Badge>{data.project.aspectRatio}</Badge>
            {data.transcript ? <Badge>{clock(data.transcript.durationSec)}</Badge> : null}
            {data.project.qualityReport ? (
              <Badge tone={data.project.qualityReport.overall >= 80 ? 'ok' : 'warn'}>
                QC {data.project.qualityReport.overall}
              </Badge>
            ) : null}
          </>
        }
      />

      {activeJob ? (
        <div className="border-b border-line bg-surface/60 px-6 py-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <JobStatusBadge status={activeJob.status} />
            <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">
              {progress?.message ?? activeJob.message ?? 'Working…'}
            </span>
            <span className="font-mono text-xs text-ink-muted">
              {Math.round(progress?.progress ?? activeJob.progress)}%
            </span>
          </div>
          <ProgressBar value={progress?.progress ?? activeJob.progress} className="mt-2" />
        </div>
      ) : null}

      <nav className="flex gap-1 overflow-x-auto border-b border-line px-4" aria-label="Project sections">
        {TABS.map((entry) => {
          const blocked = entry.blockedBy(data);
          const active = activeTab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              disabled={Boolean(blocked)}
              title={blocked ?? undefined}
              onClick={() => setTab(entry.id)}
              className={cn(
                'relative whitespace-nowrap px-3 py-3 text-xs font-medium transition-colors',
                active ? 'text-ink' : 'text-ink-muted hover:text-ink',
                blocked ? 'cursor-not-allowed opacity-40 hover:text-ink-muted' : '',
              )}
            >
              {entry.label}
              {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
            </button>
          );
        })}
      </nav>

      <div className="p-6">
        {activeTab === 'voiceover' ? <UploadStep bundle={data} onChanged={() => void reload({ quiet: true })} /> : null}
        {activeTab === 'transcript' && data.transcript ? (
          <TranscriptReview bundle={data} onChanged={() => void reload({ quiet: true })} />
        ) : null}
        {activeTab === 'references' ? (
          <ReferencesPanel bundle={data} onChanged={() => void reload({ quiet: true })} />
        ) : null}
        {activeTab === 'storyboard' ? (
          <Storyboard bundle={data} onChanged={() => void reload({ quiet: true })} />
        ) : null}
        {activeTab === 'characters' ? (
          <CharactersPanel bundle={data} onChanged={() => void reload({ quiet: true })} />
        ) : null}
        {activeTab === 'timeline' ? (
          <TimelineEditor bundle={data} onChanged={() => void reload({ quiet: true })} />
        ) : null}
        {activeTab === 'settings' ? (
          <SettingsPanel bundle={data} onChanged={() => void reload({ quiet: true })} />
        ) : null}
        {activeTab === 'export' ? (
          <ExportPanel bundle={data} onChanged={() => void reload({ quiet: true })} />
        ) : null}
      </div>
    </>
  );
}
