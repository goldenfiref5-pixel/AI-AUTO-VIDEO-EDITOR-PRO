import type { ExportFormat, ExportResolution, FrameRate, JobStatus, QualityReport, RenderRecord } from '@aiedit/shared';
import { query, queryOne } from '../db/pool';
import { getAsset, assetUrl } from './assets';
import { mapRender } from './mappers';

const COLUMNS = `id, project_id, job_id, format, resolution, fps, status, asset_id, bytes,
                 duration_sec, quality_report, created_at, finished_at`;

export interface CreateRenderData {
  projectId: string;
  format: ExportFormat;
  resolution: ExportResolution;
  fps: FrameRate;
}

export async function createRenderRecord(data: CreateRenderData): Promise<RenderRecord> {
  const row = await queryOne(
    `INSERT INTO renders (project_id, format, resolution, fps)
     VALUES ($1,$2,$3,$4) RETURNING ${COLUMNS}`,
    [data.projectId, data.format, data.resolution, data.fps],
  );
  return mapRender(row!);
}

export async function getRenderRecord(id: string): Promise<RenderRecord | null> {
  const row = await queryOne(`SELECT ${COLUMNS} FROM renders WHERE id = $1`, [id]);
  return row ? mapRender(row) : null;
}

export async function attachRenderJob(renderId: string, jobId: string): Promise<void> {
  await query('UPDATE renders SET job_id = $2 WHERE id = $1', [renderId, jobId]);
}

export interface RenderUpdate {
  status?: JobStatus;
  assetId?: string;
  bytes?: number;
  durationSec?: number;
  qualityReport?: QualityReport;
}

export async function updateRenderRecord(id: string, update: RenderUpdate): Promise<void> {
  await query(
    `UPDATE renders SET
       status = COALESCE($2, status),
       asset_id = COALESCE($3, asset_id),
       bytes = COALESCE($4, bytes),
       duration_sec = COALESCE($5, duration_sec),
       quality_report = COALESCE($6::jsonb, quality_report),
       finished_at = CASE WHEN $2 IN ('completed','failed','cancelled') THEN now() ELSE finished_at END
     WHERE id = $1`,
    [
      id,
      update.status ?? null,
      update.assetId ?? null,
      update.bytes ?? null,
      update.durationSec ?? null,
      update.qualityReport ? JSON.stringify(update.qualityReport) : null,
    ],
  );
}

/** Export history for a project, with a fresh signed URL per completed render. */
export async function listRenders(projectId: string): Promise<RenderRecord[]> {
  const rows = await query(
    `SELECT ${COLUMNS} FROM renders WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [projectId],
  );

  return Promise.all(
    rows.map(async (row) => {
      const record = mapRender(row);
      if (record.assetId) {
        const asset = await getAsset(record.assetId);
        if (asset) record.downloadUrl = await assetUrl(asset, 6 * 3600);
      }
      return record;
    }),
  );
}

export async function latestCompletedRender(projectId: string): Promise<RenderRecord | null> {
  const row = await queryOne(
    `SELECT ${COLUMNS} FROM renders WHERE project_id = $1 AND status = 'completed'
      ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  if (!row) return null;

  const record = mapRender(row);
  if (record.assetId) {
    const asset = await getAsset(record.assetId);
    if (asset) record.downloadUrl = await assetUrl(asset, 6 * 3600);
  }
  return record;
}
