import type { AdminStats } from '@aiedit/shared';
import { query, queryOne } from '../db/pool';
import { queueDepths, type QueueDepth } from '../queue/queues';

interface CountRow {
  count: string;
}

async function count(sql: string, params: readonly unknown[] = []): Promise<number> {
  const row = await queryOne<CountRow>(sql, params);
  return Number(row?.count ?? 0);
}

/**
 * Platform analytics for the admin panel.
 *
 * Costs come from the `usage_events` ledger the Gemini service writes on every
 * call, so the figure reflects real generation volume rather than an estimate
 * derived from project counts.
 */
export async function adminStats(windowDays = 30): Promise<AdminStats> {
  const [
    totalUsers,
    activeUsers,
    totalProjects,
    completedProjects,
    failedJobs,
  ] = await Promise.all([
    count('SELECT COUNT(*)::text AS count FROM users'),
    count(
      `SELECT COUNT(*)::text AS count FROM users WHERE last_seen_at > now() - ($1 || ' days')::interval`,
      [windowDays],
    ),
    count('SELECT COUNT(*)::text AS count FROM projects'),
    count("SELECT COUNT(*)::text AS count FROM projects WHERE status = 'completed'"),
    count("SELECT COUNT(*)::text AS count FROM jobs WHERE status = 'failed'"),
  ]);

  const storageRow = await queryOne<{ bytes: string }>(
    'SELECT COALESCE(SUM(bytes), 0)::text AS bytes FROM assets',
  );

  const usageRow = await queryOne<{
    calls: string;
    input_tokens: string;
    output_tokens: string;
    cost: string;
  }>(
    `SELECT COUNT(*)::text AS calls,
            COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
            COALESCE(SUM(cost_usd), 0)::text AS cost
       FROM usage_events
      WHERE created_at > now() - ($1 || ' days')::interval`,
    [windowDays],
  );

  const generationRow = await queryOne<{
    images: string;
    clip_seconds: string;
    audio_minutes: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'image' THEN units ELSE 0 END), 0)::text AS images,
       COALESCE(SUM(CASE WHEN kind = 'video' THEN units ELSE 0 END), 0)::text AS clip_seconds,
       COALESCE(SUM(CASE WHEN kind = 'transcription' THEN units ELSE 0 END), 0)::text AS audio_minutes
     FROM usage_events`,
  );

  const renders = await count("SELECT COUNT(*)::text AS count FROM renders WHERE status = 'completed'");
  const clips = await count("SELECT COUNT(*)::text AS count FROM assets WHERE kind IN ('scene_clip','broll_clip')");

  const revenueRow = await queryOne<{ mrr: string; paying: string }>(
    `SELECT COALESCE(SUM(monthly_price_usd), 0)::text AS mrr,
            COUNT(*) FILTER (WHERE monthly_price_usd > 0)::text AS paying
       FROM users`,
  );

  const payingUsers = Number(revenueRow?.paying ?? 0);
  const mrrUsd = Number(revenueRow?.mrr ?? 0);

  return {
    totalUsers,
    activeUsers,
    totalProjects,
    completedProjects,
    failedJobs,
    storageBytes: Number(storageRow?.bytes ?? 0),
    apiCalls: Number(usageRow?.calls ?? 0),
    apiTokens: Number(usageRow?.input_tokens ?? 0) + Number(usageRow?.output_tokens ?? 0),
    estimatedCostUsd: Number(Number(usageRow?.cost ?? 0).toFixed(2)),
    generation: {
      images: Math.round(Number(generationRow?.images ?? 0)),
      clips,
      renders,
      transcriptionMinutes: Math.round(Number(generationRow?.audio_minutes ?? 0)),
    },
    revenue: {
      mrrUsd: Number(mrrUsd.toFixed(2)),
      payingUsers,
      arpuUsd: payingUsers > 0 ? Number((mrrUsd / payingUsers).toFixed(2)) : 0,
    },
  };
}

export interface UsageBucket {
  day: string;
  images: number;
  clipSeconds: number;
  transcriptionMinutes: number;
  costUsd: number;
}

export async function usageTimeSeries(days = 30): Promise<UsageBucket[]> {
  const rows = await query<{
    day: Date;
    images: string;
    clip_seconds: string;
    audio_minutes: string;
    cost: string;
  }>(
    `SELECT date_trunc('day', created_at) AS day,
            COALESCE(SUM(CASE WHEN kind = 'image' THEN units ELSE 0 END), 0)::text AS images,
            COALESCE(SUM(CASE WHEN kind = 'video' THEN units ELSE 0 END), 0)::text AS clip_seconds,
            COALESCE(SUM(CASE WHEN kind = 'transcription' THEN units ELSE 0 END), 0)::text AS audio_minutes,
            COALESCE(SUM(cost_usd), 0)::text AS cost
       FROM usage_events
      WHERE created_at > now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1 ASC`,
    [days],
  );

  return rows.map((row) => ({
    day: row.day.toISOString().slice(0, 10),
    images: Math.round(Number(row.images)),
    clipSeconds: Math.round(Number(row.clip_seconds)),
    transcriptionMinutes: Math.round(Number(row.audio_minutes)),
    costUsd: Number(Number(row.cost).toFixed(4)),
  }));
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  plan: string;
  projects: number;
  storageBytes: number;
  costUsd: number;
  lastSeenAt: string | null;
  createdAt: string;
}

export async function adminUsers(limit = 100, offset = 0): Promise<AdminUserRow[]> {
  const rows = await query<{
    id: string;
    email: string;
    name: string | null;
    role: string;
    plan: string;
    projects: string;
    storage_bytes: string;
    cost_usd: string;
    last_seen_at: Date | null;
    created_at: Date;
  }>(
    `SELECT u.id, u.email, u.name, u.role, u.plan, u.last_seen_at, u.created_at,
            (SELECT COUNT(*)::text FROM projects p WHERE p.user_id = u.id) AS projects,
            (SELECT COALESCE(SUM(bytes), 0)::text FROM assets a WHERE a.user_id = u.id) AS storage_bytes,
            (SELECT COALESCE(SUM(cost_usd), 0)::text FROM usage_events e WHERE e.user_id = u.id) AS cost_usd
       FROM users u
      ORDER BY u.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    plan: row.plan,
    projects: Number(row.projects),
    storageBytes: Number(row.storage_bytes),
    costUsd: Number(Number(row.cost_usd).toFixed(4)),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }));
}

export interface FailedJobRow {
  id: string;
  projectId: string;
  type: string;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
}

export async function recentFailures(limit = 50): Promise<FailedJobRow[]> {
  const rows = await query<{
    id: string;
    project_id: string;
    type: string;
    error_message: string | null;
    attempts: number;
    created_at: Date;
  }>(
    `SELECT id, project_id, type, error_message, attempts, created_at
       FROM jobs WHERE status = 'failed' ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );

  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    errorMessage: row.error_message,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function systemHealth(): Promise<{ queues: QueueDepth[]; database: boolean }> {
  const [queues, database] = await Promise.all([
    queueDepths().catch(() => [] as QueueDepth[]),
    queryOne('SELECT 1 AS ok')
      .then(() => true)
      .catch(() => false),
  ]);
  return { queues, database };
}
