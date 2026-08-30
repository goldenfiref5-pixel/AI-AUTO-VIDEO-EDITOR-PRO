import type { Template, TemplateKind } from '@aiedit/shared';
import { query, queryOne } from '../db/pool';
import { notFound } from '../utils/errors';
import { mapTemplate } from './mappers';

const COLUMNS = `id, user_id, kind, name, description, payload, created_at, updated_at`;

export async function listTemplates(userId: string, kind?: TemplateKind): Promise<Template[]> {
  const rows = kind
    ? await query(
        `SELECT ${COLUMNS} FROM templates WHERE user_id = $1 AND kind = $2 ORDER BY updated_at DESC`,
        [userId, kind],
      )
    : await query(`SELECT ${COLUMNS} FROM templates WHERE user_id = $1 ORDER BY updated_at DESC`, [
        userId,
      ]);
  return rows.map(mapTemplate);
}

export async function createTemplate(params: {
  userId: string;
  kind: TemplateKind;
  name: string;
  description?: string | null;
  payload: Record<string, unknown>;
}): Promise<Template> {
  const row = await queryOne(
    `INSERT INTO templates (user_id, kind, name, description, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING ${COLUMNS}`,
    [params.userId, params.kind, params.name, params.description ?? null, JSON.stringify(params.payload)],
  );
  return mapTemplate(row!);
}

export async function updateTemplate(
  id: string,
  userId: string,
  update: { name?: string; description?: string | null; payload?: Record<string, unknown> },
): Promise<Template> {
  const row = await queryOne(
    `UPDATE templates SET
       name = COALESCE($3, name),
       description = CASE WHEN $4::boolean THEN $5 ELSE description END,
       payload = COALESCE($6::jsonb, payload)
     WHERE id = $1 AND user_id = $2
     RETURNING ${COLUMNS}`,
    [
      id,
      userId,
      update.name ?? null,
      update.description !== undefined,
      update.description ?? null,
      update.payload ? JSON.stringify(update.payload) : null,
    ],
  );
  if (!row) throw notFound('Template not found');
  return mapTemplate(row);
}

export async function deleteTemplate(id: string, userId: string): Promise<void> {
  const rows = await query('DELETE FROM templates WHERE id = $1 AND user_id = $2 RETURNING id', [
    id,
    userId,
  ]);
  if (rows.length === 0) throw notFound('Template not found');
}

export async function requireTemplate(id: string, userId: string): Promise<Template> {
  const row = await queryOne(`SELECT ${COLUMNS} FROM templates WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  if (!row) throw notFound('Template not found');
  return mapTemplate(row);
}
