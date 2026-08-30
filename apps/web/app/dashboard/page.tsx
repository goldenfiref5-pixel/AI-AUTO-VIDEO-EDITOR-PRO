'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Project } from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { clock, formatRelative, pluralize } from '@/lib/utils';
import { AppShell } from '@/components/app-shell';
import { PageHeader } from '@/components/page-header';
import { ProjectStatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import { EmptyState, Input, ProgressBar, Select, Skeleton } from '@/components/ui/primitives';
import { NewProjectModal } from '@/components/new-project-modal';

interface ProjectListResponse {
  items: Project[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 24;

export default function DashboardPage() {
  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}

function Dashboard() {
  const toast = useToast();
  const [data, setData] = useState<ProjectListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get<ProjectListResponse>('/api/projects', {
        query: { page, pageSize: PAGE_SIZE, search: search || undefined, status: status || undefined },
      });
      setData(response);
    } catch (err) {
      if (err instanceof ApiError) toast.error('Could not load projects', err.message);
    } finally {
      setLoading(false);
    }
  }, [page, search, status, toast]);

  useEffect(() => {
    // Debounce so typing in the search box does not fire a request per keystroke.
    const timer = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  // Projects in flight change status server side; a slow poll keeps the grid
  // honest without a socket per card.
  useEffect(() => {
    const active = data?.items.some((p) =>
      ['transcribing', 'analyzing', 'generating', 'rendering'].includes(p.status),
    );
    if (!active) return undefined;
    const timer = setInterval(() => void load(), 6000);
    return () => clearInterval(timer);
  }, [data, load]);

  async function onDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/api/projects/${deleting.id}`);
      toast.success('Project deleted');
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error('Delete failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setDeleteBusy(false);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader
        title="Projects"
        description="Every video you are producing, from voiceover upload to final export."
        actions={<Button onClick={() => setCreating(true)}>New project</Button>}
      />

      <div className="p-6">
        <div className="mb-5 flex flex-wrap gap-2">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search projects…"
            className="max-w-xs"
            aria-label="Search projects"
          />
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="max-w-[200px]"
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="transcript_ready">Transcript ready</option>
            <option value="storyboard_ready">Storyboard ready</option>
            <option value="generating">Generating</option>
            <option value="rendering">Rendering</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </Select>
        </div>

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-36" />
            ))}
          </div>
        ) : data && data.items.length > 0 ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.items.map((project) => (
                <ProjectCard key={project.id} project={project} onDelete={() => setDeleting(project)} />
              ))}
            </div>

            {totalPages > 1 ? (
              <div className="mt-6 flex items-center justify-center gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span className="text-xs text-ink-muted">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState
            title={search || status ? 'No projects match those filters' : 'No projects yet'}
            description={
              search || status
                ? 'Try a different search term or clear the status filter.'
                : 'Create a project, upload a voiceover, and the pipeline takes it from there.'
            }
            action={
              search || status ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setStatus('');
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button onClick={() => setCreating(true)}>Create your first project</Button>
              )
            }
          />
        )}
      </div>

      <NewProjectModal open={creating} onClose={() => setCreating(false)} />

      <ConfirmModal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void onDelete()}
        title="Delete this project?"
        description={`"${deleting?.name}" and all of its transcripts, scenes and generated media will be permanently removed.`}
        confirmLabel="Delete project"
        destructive
        loading={deleteBusy}
      />
    </>
  );
}

function ProjectCard({ project, onDelete }: { project: Project; onDelete: () => void }) {
  const inFlight = ['transcribing', 'analyzing', 'generating', 'rendering'].includes(project.status);

  return (
    <div className="card group relative p-4 transition-colors hover:border-line-strong">
      <div className="mb-3 flex items-start justify-between gap-2">
        <Link href={`/projects/${project.id}`} className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-ink group-hover:text-white">{project.name}</h3>
          {project.videoTitle ? (
            <p className="truncate text-xs text-ink-muted">{project.videoTitle}</p>
          ) : null}
        </Link>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${project.name}`}
          className="shrink-0 rounded-md p-1 text-ink-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <Link href={`/projects/${project.id}`} className="block">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ProjectStatusBadge status={project.status} />
          <span className="rounded-md bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            {project.aspectRatio}
          </span>
          {project.targetDurationSec ? (
            <span className="text-[11px] text-ink-faint">{clock(project.targetDurationSec)} target</span>
          ) : null}
        </div>

        {inFlight ? (
          <div className="mb-3">
            <ProgressBar value={project.progress} />
            <p className="mt-1 text-[11px] text-ink-faint">{Math.round(project.progress)}% complete</p>
          </div>
        ) : null}

        {project.status === 'failed' && project.errorMessage ? (
          <p className="mb-3 line-clamp-2 rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">
            {project.errorMessage}
          </p>
        ) : null}

        <div className="flex items-center justify-between text-[11px] text-ink-faint">
          <span>Edited {formatRelative(project.updatedAt)}</span>
          {project.qualityReport ? (
            <span className="font-mono">
              QC {project.qualityReport.overall} · {project.qualityReport.grade}
            </span>
          ) : (
            <span>{pluralize(project.settings.export.fps, 'fps')}</span>
          )}
        </div>
      </Link>
    </div>
  );
}
