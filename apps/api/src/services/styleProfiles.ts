import type { CompetitorInsight, StyleDna } from '@aiedit/shared';
import { query, queryOne } from '../db/pool';
import { notFound } from '../utils/errors';
import type { CompetitorDraft } from '../pipeline/competitor';
import type { StyleDnaDraft } from '../pipeline/styleDna';
import { mapCompetitorInsight, mapStyleDna } from './mappers';

const STYLE_COLUMNS = `id, project_id, name, summary, color_palette, color_grading, lighting,
                       composition, camera_lens, camera_style, mood, realism_level, artistic_style,
                       texture_detail, negative_prompt, prompt_suffix, source_asset_ids, locked,
                       created_at, updated_at`;

export async function getStyleDna(projectId: string): Promise<StyleDna | null> {
  const row = await queryOne(`SELECT ${STYLE_COLUMNS} FROM style_profiles WHERE project_id = $1`, [
    projectId,
  ]);
  return row ? mapStyleDna(row) : null;
}

export async function upsertStyleDna(projectId: string, draft: StyleDnaDraft): Promise<StyleDna> {
  const row = await queryOne(
    `INSERT INTO style_profiles (project_id, name, summary, color_palette, color_grading, lighting,
                                 composition, camera_lens, camera_style, mood, realism_level,
                                 artistic_style, texture_detail, negative_prompt, prompt_suffix,
                                 source_asset_ids)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
     ON CONFLICT (project_id) DO UPDATE SET
       name = EXCLUDED.name,
       summary = EXCLUDED.summary,
       color_palette = EXCLUDED.color_palette,
       color_grading = EXCLUDED.color_grading,
       lighting = EXCLUDED.lighting,
       composition = EXCLUDED.composition,
       camera_lens = EXCLUDED.camera_lens,
       camera_style = EXCLUDED.camera_style,
       mood = EXCLUDED.mood,
       realism_level = EXCLUDED.realism_level,
       artistic_style = EXCLUDED.artistic_style,
       texture_detail = EXCLUDED.texture_detail,
       negative_prompt = EXCLUDED.negative_prompt,
       prompt_suffix = EXCLUDED.prompt_suffix,
       source_asset_ids = EXCLUDED.source_asset_ids
     RETURNING ${STYLE_COLUMNS}`,
    [
      projectId,
      draft.name,
      draft.summary,
      JSON.stringify(draft.colorPalette),
      draft.colorGrading,
      draft.lighting,
      draft.composition,
      draft.cameraLens,
      draft.cameraStyle,
      draft.mood,
      draft.realismLevel,
      draft.artisticStyle,
      draft.textureDetail,
      draft.negativePrompt,
      draft.promptSuffix,
      JSON.stringify(draft.sourceAssetIds),
    ],
  );
  return mapStyleDna(row!);
}

export interface StyleDnaUpdate extends Partial<Omit<StyleDna, 'id' | 'projectId' | 'createdAt'>> {}

export async function updateStyleDna(projectId: string, update: StyleDnaUpdate): Promise<StyleDna> {
  const sets: string[] = [];
  const values: unknown[] = [projectId];

  const push = (column: string, value: unknown, cast = '') => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };

  if (update.name !== undefined) push('name', update.name);
  if (update.summary !== undefined) push('summary', update.summary);
  if (update.colorPalette !== undefined) push('color_palette', JSON.stringify(update.colorPalette), '::jsonb');
  if (update.colorGrading !== undefined) push('color_grading', update.colorGrading);
  if (update.lighting !== undefined) push('lighting', update.lighting);
  if (update.composition !== undefined) push('composition', update.composition);
  if (update.cameraLens !== undefined) push('camera_lens', update.cameraLens);
  if (update.cameraStyle !== undefined) push('camera_style', update.cameraStyle);
  if (update.mood !== undefined) push('mood', update.mood);
  if (update.realismLevel !== undefined) push('realism_level', update.realismLevel);
  if (update.artisticStyle !== undefined) push('artistic_style', update.artisticStyle);
  if (update.textureDetail !== undefined) push('texture_detail', update.textureDetail);
  if (update.negativePrompt !== undefined) push('negative_prompt', update.negativePrompt);
  if (update.promptSuffix !== undefined) push('prompt_suffix', update.promptSuffix);
  if (update.locked !== undefined) push('locked', update.locked);

  if (sets.length === 0) {
    const current = await getStyleDna(projectId);
    if (!current) throw notFound('This project has no Style DNA yet.');
    return current;
  }

  const row = await queryOne(
    `UPDATE style_profiles SET ${sets.join(', ')} WHERE project_id = $1 RETURNING ${STYLE_COLUMNS}`,
    values,
  );
  if (!row) throw notFound('This project has no Style DNA yet.');
  return mapStyleDna(row);
}

const INSIGHT_COLUMNS = `id, project_id, asset_id, source_url, editing_pace, avg_scene_duration_sec,
                         story_structure, caption_style, transition_style, camera_movement,
                         hook_structure, visual_rhythm, scene_duration_pattern, recommendations,
                         created_at`;

export async function listCompetitorInsights(projectId: string): Promise<CompetitorInsight[]> {
  const rows = await query(
    `SELECT ${INSIGHT_COLUMNS} FROM competitor_insights WHERE project_id = $1 ORDER BY created_at ASC`,
    [projectId],
  );
  return rows.map(mapCompetitorInsight);
}

export async function insertCompetitorInsight(
  projectId: string,
  draft: CompetitorDraft,
): Promise<CompetitorInsight> {
  const row = await queryOne(
    `INSERT INTO competitor_insights (project_id, asset_id, source_url, editing_pace,
                                      avg_scene_duration_sec, story_structure, caption_style,
                                      transition_style, camera_movement, hook_structure,
                                      visual_rhythm, scene_duration_pattern, recommendations)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
     RETURNING ${INSIGHT_COLUMNS}`,
    [
      projectId,
      draft.assetId,
      draft.sourceUrl,
      draft.editingPace,
      draft.avgSceneDurationSec,
      draft.storyStructure,
      draft.captionStyle,
      draft.transitionStyle,
      draft.cameraMovement,
      draft.hookStructure,
      draft.visualRhythm,
      JSON.stringify(draft.sceneDurationPattern),
      JSON.stringify(draft.recommendations),
    ],
  );
  return mapCompetitorInsight(row!);
}

export async function deleteCompetitorInsight(id: string, projectId: string): Promise<void> {
  await query('DELETE FROM competitor_insights WHERE id = $1 AND project_id = $2', [id, projectId]);
}
