import type { DeepPartial, Project, ProjectSettings, ProjectStatus, QualityReport } from '@aiedit/shared';
import { query, queryOne } from '../db/pool';
import { forbidden, notFound } from '../utils/errors';
import { deepMerge } from '../utils/json';
import { mapProject } from './mappers';

const COLUMNS = `id, user_id, name, video_title, aspect_ratio, target_duration_sec, language,
                 status, progress, settings, quality_report, error_message, created_at, updated_at`;

export interface CreateProjectData {
  userId: string;
  name: string;
  videoTitle: string | null;
  aspectRatio: Project['aspectRatio'];
  targetDurationSec: number | null;
  language: string;
  settings: Partial<ProjectSettings>;
}

export async function createProject(data: CreateProjectData): Promise<Project> {
  const row = await queryOne(
    `INSERT INTO projects (user_id, name, video_title, aspect_ratio, target_duration_sec, language, settings)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${COLUMNS}`,
    [
      data.userId,
      data.name,
      data.videoTitle,
      data.aspectRatio,
      data.targetDurationSec,
      data.language,
      JSON.stringify(data.settings ?? {}),
    ],
  );
  return mapProject(row!);
}

export async function getProject(id: string): Promise<Project | null> {
  const row = await queryOne(`SELECT ${COLUMNS} FROM projects WHERE id = $1`, [id]);
  return row ? mapProject(row) : null;
}

/** Fetch a project, refusing access when it belongs to somebody else. */
export async function requireProject(id: string, userId: string, isAdmin = false): Promise<Project> {
  const project = await getProject(id);
  if (!project) throw notFound('Project not found');
  if (!isAdmin && project.userId !== userId) throw forbidden('This project belongs to another account');
  return project;
}

export interface ListProjectsParams {
  userId: string;
  page: number;
  pageSize: number;
  status?: ProjectStatus;
  search?: string;
}

export async function listProjects(
  params: ListProjectsParams,
): Promise<{ items: Project[]; total: number }> {
  const filters: string[] = ['user_id = $1'];
  const values: unknown[] = [params.userId];

  if (params.status) {
    values.push(params.status);
    filters.push(`status = $${values.length}`);
  }
  if (params.search) {
    values.push(`%${params.search}%`);
    filters.push(`(name ILIKE $${values.length} OR video_title ILIKE $${values.length})`);
  }

  const where = filters.join(' AND ');
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM projects WHERE ${where}`,
    values,
  );

  values.push(params.pageSize, (params.page - 1) * params.pageSize);
  const rows = await query(
    `SELECT ${COLUMNS} FROM projects
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return { items: rows.map(mapProject), total: Number(countRow?.count ?? 0) };
}

export interface UpdateProjectData {
  name?: string;
  videoTitle?: string | null;
  aspectRatio?: Project['aspectRatio'];
  targetDurationSec?: number | null;
  language?: string;
  settings?: DeepPartial<ProjectSettings>;
}

export async function updateProject(
  project: Project,
  data: UpdateProjectData,
): Promise<Project> {
  const settings = data.settings
    ? deepMerge<ProjectSettings>(project.settings, data.settings)
    : undefined;

  const row = await queryOne(
    `UPDATE projects SET
       name = COALESCE($2, name),
       video_title = CASE WHEN $3::boolean THEN $4 ELSE video_title END,
       aspect_ratio = COALESCE($5, aspect_ratio),
       target_duration_sec = CASE WHEN $6::boolean THEN $7 ELSE target_duration_sec END,
       language = COALESCE($8, language),
       settings = COALESCE($9::jsonb, settings)
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [
      project.id,
      data.name ?? null,
      data.videoTitle !== undefined,
      data.videoTitle ?? null,
      data.aspectRatio ?? null,
      data.targetDurationSec !== undefined,
      data.targetDurationSec ?? null,
      data.language ?? null,
      settings ? JSON.stringify(settings) : null,
    ],
  );
  return mapProject(row!);
}

export async function setProjectStatus(
  projectId: string,
  status: ProjectStatus,
  options: { progress?: number; errorMessage?: string | null } = {},
): Promise<void> {
  await query(
    `UPDATE projects SET
       status = $2,
       progress = COALESCE($3, progress),
       error_message = CASE WHEN $4::boolean THEN $5 ELSE error_message END
     WHERE id = $1`,
    [
      projectId,
      status,
      options.progress ?? null,
      options.errorMessage !== undefined,
      options.errorMessage ?? null,
    ],
  );
}

export async function setProjectProgress(projectId: string, progress: number): Promise<void> {
  await query('UPDATE projects SET progress = $2 WHERE id = $1', [
    projectId,
    Math.max(0, Math.min(100, progress)),
  ]);
}

export async function setQualityReport(projectId: string, report: QualityReport): Promise<void> {
  await query('UPDATE projects SET quality_report = $2 WHERE id = $1', [
    projectId,
    JSON.stringify(report),
  ]);
}

export async function deleteProject(projectId: string): Promise<void> {
  // Assets cascade at the DB level; the storage objects are swept separately by
  // the maintenance task so a delete stays fast.
  await query('DELETE FROM projects WHERE id = $1', [projectId]);
}

export async function projectVideoTitle(project: Project): Promise<string> {
  return project.videoTitle?.trim() || project.name;
}
