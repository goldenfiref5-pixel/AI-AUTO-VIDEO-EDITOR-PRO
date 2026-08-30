'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminStats } from '@aiedit/shared';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { cn, formatBytes, formatNumber, formatRelative, formatUsd } from '@/lib/utils';
import { AppShell } from '@/components/app-shell';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Select, Skeleton } from '@/components/ui/primitives';

interface UsageBucket {
  day: string;
  images: number;
  clipSeconds: number;
  transcriptionMinutes: number;
  costUsd: number;
}

interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  plan: string;
  projects: number;
  storageBytes: number;
  costUsd: number;
  lastSeenAt: string | null;
}

interface FailureRow {
  id: string;
  projectId: string;
  type: string;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
}

interface QueueDepth {
  name: string;
  waiting: number;
  active: number;
  failed: number;
  paused: boolean;
}

export default function AdminPage() {
  return (
    <AppShell>
      <Admin />
    </AppShell>
  );
}

function Admin() {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [series, setSeries] = useState<UsageBucket[]>([]);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [failures, setFailures] = useState<FailureRow[]>([]);
  const [queues, setQueues] = useState<QueueDepth[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [statsRes, usageRes, usersRes, failuresRes, healthRes] = await Promise.all([
        api.get<{ stats: AdminStats }>('/api/admin/stats', { query: { days } }),
        api.get<{ series: UsageBucket[] }>('/api/admin/usage', { query: { days } }),
        api.get<{ users: AdminUserRow[] }>('/api/admin/users', { query: { limit: 25 } }),
        api.get<{ failures: FailureRow[] }>('/api/admin/failures', { query: { limit: 15 } }),
        api.get<{ queues: QueueDepth[] }>('/api/admin/health'),
      ]);
      setStats(statsRes.stats);
      setSeries(usageRes.series);
      setUsers(usersRes.users);
      setFailures(failuresRes.failures);
      setQueues(healthRes.queues);
    } catch (err) {
      if (err instanceof ApiError) toast.error('Could not load analytics', err.message);
    } finally {
      setLoading(false);
    }
  }, [days, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !stats) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Admin"
        description="Platform usage, generation volume, spend and system health."
        actions={
          <>
            <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </Select>
            <Button variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          </>
        }
      />

      <div className="space-y-4 p-6">
        {stats ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Total users" value={formatNumber(stats.totalUsers)} sub={`${stats.activeUsers} active`} />
              <StatCard
                label="Projects"
                value={formatNumber(stats.totalProjects)}
                sub={`${stats.completedProjects} completed`}
              />
              <StatCard label="Storage" value={formatBytes(stats.storageBytes)} sub="Across all assets" />
              <StatCard
                label="Estimated spend"
                value={formatUsd(stats.estimatedCostUsd)}
                sub={`${formatNumber(stats.apiCalls)} API calls`}
                tone={stats.estimatedCostUsd > 500 ? 'text-warn' : 'text-ink'}
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Images generated" value={formatNumber(stats.generation.images)} />
              <StatCard label="Motion clips" value={formatNumber(stats.generation.clips)} />
              <StatCard label="Renders completed" value={formatNumber(stats.generation.renders)} />
              <StatCard
                label="Audio transcribed"
                value={`${formatNumber(stats.generation.transcriptionMinutes)} min`}
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <StatCard label="MRR" value={formatUsd(stats.revenue.mrrUsd)} />
              <StatCard label="Paying users" value={formatNumber(stats.revenue.payingUsers)} />
              <StatCard label="ARPU" value={formatUsd(stats.revenue.arpuUsd)} />
            </div>
          </>
        ) : null}

        {series.length > 0 ? <UsageChart series={series} /> : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="card overflow-hidden">
            <header className="border-b border-line px-4 py-3">
              <h3 className="text-sm font-semibold text-ink">Queue health</h3>
            </header>
            {queues.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-ink-muted">Queue metrics unavailable.</p>
            ) : (
              <ul className="divide-y divide-line">
                {queues.map((queue) => (
                  <li key={queue.name} className="flex items-center justify-between px-4 py-2.5 text-xs">
                    <span className="capitalize text-ink">{queue.name.replace('aiedit:', '')}</span>
                    <span className="flex gap-3 text-ink-muted">
                      <span>{queue.active} active</span>
                      <span>{queue.waiting} waiting</span>
                      {queue.failed > 0 ? <span className="text-danger">{queue.failed} failed</span> : null}
                      {queue.paused ? <Badge tone="warn">Paused</Badge> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card overflow-hidden">
            <header className="border-b border-line px-4 py-3">
              <h3 className="text-sm font-semibold text-ink">Recent failures</h3>
            </header>
            {failures.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-ok">No failed jobs. Everything is healthy.</p>
            ) : (
              <ul className="max-h-72 divide-y divide-line overflow-y-auto">
                {failures.map((failure) => (
                  <li key={failure.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-ink">{failure.type.replace(/_/g, ' ')}</span>
                      <span className="text-ink-faint">{formatRelative(failure.createdAt)}</span>
                    </div>
                    {failure.errorMessage ? (
                      <p className="mt-1 line-clamp-2 text-[11px] text-danger">{failure.errorMessage}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="card overflow-hidden">
          <header className="border-b border-line px-4 py-3">
            <h3 className="text-sm font-semibold text-ink">Users</h3>
          </header>
          {users.length === 0 ? (
            <EmptyState title="No users" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-line text-left text-ink-faint">
                  <tr>
                    <th className="px-4 py-2 font-medium">Email</th>
                    <th className="px-4 py-2 font-medium">Role</th>
                    <th className="px-4 py-2 text-right font-medium">Projects</th>
                    <th className="px-4 py-2 text-right font-medium">Storage</th>
                    <th className="px-4 py-2 text-right font-medium">Spend</th>
                    <th className="px-4 py-2 text-right font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-surface-hover">
                      <td className="px-4 py-2">
                        <p className="text-ink">{user.email}</p>
                        {user.name ? <p className="text-[11px] text-ink-faint">{user.name}</p> : null}
                      </td>
                      <td className="px-4 py-2">
                        {user.role === 'admin' ? <Badge tone="brand">Admin</Badge> : <span className="text-ink-muted">User</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-ink-muted">{user.projects}</td>
                      <td className="px-4 py-2 text-right font-mono text-ink-muted">
                        {formatBytes(user.storageBytes)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-ink-muted">
                        {formatUsd(user.costUsd)}
                      </td>
                      <td className="px-4 py-2 text-right text-ink-faint">{formatRelative(user.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = 'text-ink',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="card p-3">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('mt-0.5 font-mono text-xl', tone)}>{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-ink-muted">{sub}</p> : null}
    </div>
  );
}

/**
 * Inline SVG bar chart. A charting dependency would be more capable, but this
 * view needs one honest series and nothing else.
 */
function UsageChart({ series }: { series: UsageBucket[] }) {
  const max = Math.max(...series.map((b) => b.costUsd), 0.0001);
  const totalCost = series.reduce((sum, b) => sum + b.costUsd, 0);

  return (
    <section className="card p-4">
      <header className="mb-4 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-ink">Daily generation spend</h3>
        <span className="font-mono text-xs text-ink-muted">{formatUsd(totalCost)} total</span>
      </header>

      <div className="flex h-32 items-end gap-0.5" role="img" aria-label="Daily generation spend">
        {series.map((bucket) => (
          <div
            key={bucket.day}
            className="group relative flex-1 rounded-t bg-brand/70 transition-colors hover:bg-brand"
            style={{ height: `${Math.max(2, (bucket.costUsd / max) * 100)}%` }}
          >
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded border border-line bg-surface-raised px-2 py-1 text-[10px] text-ink shadow-lg group-hover:block">
              <p className="font-medium">{bucket.day}</p>
              <p className="text-ink-muted">{formatUsd(bucket.costUsd)}</p>
              <p className="text-ink-faint">
                {bucket.images} images · {bucket.clipSeconds}s clips
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 flex justify-between text-[10px] text-ink-faint">
        <span>{series[0]?.day}</span>
        <span>{series[series.length - 1]?.day}</span>
      </div>
    </section>
  );
}
