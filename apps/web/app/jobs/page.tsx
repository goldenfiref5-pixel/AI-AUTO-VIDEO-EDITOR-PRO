'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Job } from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { formatRelative } from '@/lib/utils';
import { AppShell } from '@/components/app-shell';
import { PageHeader } from '@/components/page-header';
import { JobStatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ProgressBar, Select, Skeleton } from '@/components/ui/primitives';

interface JobsResponse {
  items: Job[];
  total: number;
}

interface QueueDepth {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  paused: boolean;
}

const TYPE_LABELS: Record<Job['type'], string> = {
  transcribe: 'Transcription',
  analyze_references: 'Reference analysis',
  story_analysis: 'Story analysis',
  generate_images: 'Image generation',
  generate_clips: 'Motion generation',
  render: 'Render',
};

const ACTIVE = ['pending', 'processing', 'generating_images', 'generating_video', 'rendering'];

export default function JobsPage() {
  return (
    <AppShell>
      <Jobs />
    </AppShell>
  );
}

function Jobs() {
  const toast = useToast();
  const [data, setData] = useState<JobsResponse | null>(null);
  const [queues, setQueues] = useState<QueueDepth[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [jobs, depth] = await Promise.all([
        api.get<JobsResponse>('/api/jobs', { query: { pageSize: 50, status: status || undefined } }),
        api.get<{ queues: QueueDepth[] }>('/api/jobs/queues/depth').catch(() => ({ queues: [] })),
      ]);
      setData(jobs);
      setQueues(depth.queues);
    } catch (err) {
      if (err instanceof ApiError) toast.error('Could not load the queue', err.message);
    } finally {
      setLoading(false);
    }
  }, [status, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while anything is in flight; stop once the queue drains.
  useEffect(() => {
    if (!data?.items.some((job) => ACTIVE.includes(job.status))) return undefined;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [data, load]);

  async function act(job: Job, action: 'cancel' | 'retry') {
    setBusyId(job.id);
    try {
      await api.post(`/api/jobs/${job.id}/${action}`);
      toast.success(action === 'cancel' ? 'Job cancelled' : 'Job re-queued');
      await load();
    } catch (err) {
      toast.error(`Could not ${action} the job`, err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Job queue"
        description="Every pipeline stage across all your projects, with live progress."
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        }
      />

      <div className="space-y-4 p-6">
        {queues.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {queues.map((queue) => (
              <div key={queue.name} className="card p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium capitalize text-ink">
                    {queue.name.replace('aiedit:', '')}
                  </p>
                  {queue.paused ? <span className="text-[10px] text-warn">Paused</span> : null}
                </div>
                <div className="mt-1.5 flex gap-3 text-[11px] text-ink-muted">
                  <span>{queue.active} active</span>
                  <span>{queue.waiting} waiting</span>
                  {queue.failed > 0 ? <span className="text-danger">{queue.failed} failed</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : data && data.items.length > 0 ? (
          <div className="card divide-y divide-line overflow-hidden">
            {data.items.map((job) => (
              <div key={job.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <JobStatusBadge status={job.status} />
                  <span className="text-sm text-ink">{TYPE_LABELS[job.type]}</span>
                  <Link
                    href={`/projects/${job.projectId}`}
                    className="font-mono text-[11px] text-brand hover:underline"
                  >
                    {job.projectId.slice(0, 8)}
                  </Link>

                  <span className="ml-auto text-[11px] text-ink-faint">
                    {formatRelative(job.finishedAt ?? job.startedAt ?? job.createdAt)}
                  </span>

                  {ACTIVE.includes(job.status) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busyId === job.id}
                      onClick={() => void act(job, 'cancel')}
                    >
                      Cancel
                    </Button>
                  ) : ['failed', 'cancelled'].includes(job.status) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busyId === job.id}
                      onClick={() => void act(job, 'retry')}
                    >
                      Retry
                    </Button>
                  ) : null}
                </div>

                {ACTIVE.includes(job.status) ? (
                  <div className="mt-2">
                    <ProgressBar value={job.progress} />
                    <p className="mt-1 text-[11px] text-ink-muted">
                      {job.message ?? 'Working…'}
                      {job.total > 0 ? ` · ${job.completed}/${job.total}` : ''}
                      {job.failed > 0 ? ` · ${job.failed} failed` : ''}
                    </p>
                  </div>
                ) : null}

                {job.errorMessage ? (
                  <p className="mt-2 line-clamp-2 rounded bg-danger/10 px-2 py-1 text-[11px] text-danger">
                    {job.errorMessage}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No jobs to show"
            description={status ? 'Nothing matches that status filter.' : 'Jobs appear here once a project starts processing.'}
          />
        )}
      </div>
    </>
  );
}
