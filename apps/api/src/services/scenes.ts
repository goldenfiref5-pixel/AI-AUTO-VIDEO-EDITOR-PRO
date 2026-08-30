import type { CharacterProfile, Scene, TranscriptWord } from '@aiedit/shared';
import { LIMITS } from '@aiedit/shared';
import { query, queryOne, withTransaction } from '../db/pool';
import { badRequest, notFound } from '../utils/errors';
import { mapScene } from './mappers';

const COLUMNS = `id, project_id, scene_index, start_sec, end_sec, narration, visual_prompt,
                 negative_prompt, emotion, location, character_ids, camera_motion, motion_prompt,
                 transition_in, is_broll, broll_subject, status, image_asset_id, clip_asset_id,
                 words, attempts, error_message, created_at, updated_at`;

export interface SceneDraft {
  index: number;
  startSec: number;
  endSec: number;
  narration: string;
  visualPrompt: string;
  negativePrompt: string | null;
  emotion: string;
  location: string;
  characterIds: string[];
  cameraMotion: Scene['cameraMotion'];
  motionPrompt: string | null;
  isBroll: boolean;
  brollSubject: string | null;
  words: TranscriptWord[];
}

/** Replace a project's storyboard wholesale — used after story analysis. */
export async function replaceScenes(projectId: string, drafts: SceneDraft[]): Promise<Scene[]> {
  return withTransaction(async (client) => {
    await client.query('DELETE FROM scenes WHERE project_id = $1', [projectId]);
    if (drafts.length === 0) return [];

    const values: unknown[] = [];
    const tuples = drafts.map((draft, i) => {
      const base = i * 15;
      values.push(
        projectId,
        draft.index,
        draft.startSec,
        draft.endSec,
        draft.narration,
        draft.visualPrompt,
        draft.negativePrompt,
        draft.emotion,
        draft.location,
        JSON.stringify(draft.characterIds),
        draft.cameraMotion,
        draft.motionPrompt,
        draft.isBroll,
        draft.brollSubject,
        JSON.stringify(draft.words),
      );
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},
               $${base + 8},$${base + 9},$${base + 10}::jsonb,$${base + 11},$${base + 12},$${base + 13},
               $${base + 14},$${base + 15}::jsonb)`;
    });

    const { rows } = await client.query(
      `INSERT INTO scenes (project_id, scene_index, start_sec, end_sec, narration, visual_prompt,
                           negative_prompt, emotion, location, character_ids, camera_motion,
                           motion_prompt, is_broll, broll_subject, words)
       VALUES ${tuples.join(',')}
       RETURNING ${COLUMNS}`,
      values,
    );
    return rows.map(mapScene).sort((a, b) => a.index - b.index);
  });
}

export async function listScenes(projectId: string): Promise<Scene[]> {
  const rows = await query(
    `SELECT ${COLUMNS} FROM scenes WHERE project_id = $1 ORDER BY scene_index ASC`,
    [projectId],
  );
  return rows.map(mapScene);
}

export async function getScene(sceneId: string): Promise<Scene | null> {
  const row = await queryOne(`SELECT ${COLUMNS} FROM scenes WHERE id = $1`, [sceneId]);
  return row ? mapScene(row) : null;
}

export async function requireScene(sceneId: string, projectId: string): Promise<Scene> {
  const scene = await getScene(sceneId);
  if (!scene || scene.projectId !== projectId) throw notFound('Scene not found in this project');
  return scene;
}

export interface SceneUpdate {
  narration?: string;
  visualPrompt?: string;
  negativePrompt?: string | null;
  emotion?: string;
  location?: string;
  characterIds?: string[];
  cameraMotion?: Scene['cameraMotion'];
  motionPrompt?: string | null;
  transitionIn?: Scene['transitionIn'];
  startSec?: number;
  endSec?: number;
  isBroll?: boolean;
  brollSubject?: string | null;
  status?: Scene['status'];
  imageAssetId?: string | null;
  clipAssetId?: string | null;
  errorMessage?: string | null;
  words?: TranscriptWord[];
}

export async function updateScene(sceneId: string, update: SceneUpdate): Promise<Scene> {
  const sets: string[] = [];
  const values: unknown[] = [sceneId];

  const push = (column: string, value: unknown, cast = '') => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };

  if (update.narration !== undefined) push('narration', update.narration);
  if (update.visualPrompt !== undefined) push('visual_prompt', update.visualPrompt);
  if (update.negativePrompt !== undefined) push('negative_prompt', update.negativePrompt);
  if (update.emotion !== undefined) push('emotion', update.emotion);
  if (update.location !== undefined) push('location', update.location);
  if (update.characterIds !== undefined) push('character_ids', JSON.stringify(update.characterIds), '::jsonb');
  if (update.cameraMotion !== undefined) push('camera_motion', update.cameraMotion);
  if (update.motionPrompt !== undefined) push('motion_prompt', update.motionPrompt);
  if (update.transitionIn !== undefined) push('transition_in', update.transitionIn);
  if (update.startSec !== undefined) push('start_sec', update.startSec);
  if (update.endSec !== undefined) push('end_sec', update.endSec);
  if (update.isBroll !== undefined) push('is_broll', update.isBroll);
  if (update.brollSubject !== undefined) push('broll_subject', update.brollSubject);
  if (update.status !== undefined) push('status', update.status);
  if (update.imageAssetId !== undefined) push('image_asset_id', update.imageAssetId);
  if (update.clipAssetId !== undefined) push('clip_asset_id', update.clipAssetId);
  if (update.errorMessage !== undefined) push('error_message', update.errorMessage);
  if (update.words !== undefined) push('words', JSON.stringify(update.words), '::jsonb');

  if (sets.length === 0) {
    const scene = await getScene(sceneId);
    if (!scene) throw notFound('Scene not found');
    return scene;
  }

  const row = await queryOne(
    `UPDATE scenes SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
    values,
  );
  if (!row) throw notFound('Scene not found');
  return mapScene(row);
}

export async function incrementAttempts(sceneId: string): Promise<void> {
  await query('UPDATE scenes SET attempts = attempts + 1 WHERE id = $1', [sceneId]);
}

/**
 * Split a scene at an absolute timeline position. Words are divided at the
 * split point so both halves keep correct narration and captions.
 */
export async function splitScene(scene: Scene, atSec: number): Promise<Scene[]> {
  if (atSec <= scene.startSec + 0.2 || atSec >= scene.endSec - 0.2) {
    throw badRequest('The split point must fall at least 0.2s inside the scene.');
  }

  const first = scene.words.filter((w) => w.end <= atSec);
  const second = scene.words.filter((w) => w.end > atSec);

  return withTransaction(async (client) => {
    // Make room for the new scene by shifting every later index up by one.
    await client.query(
      `UPDATE scenes SET scene_index = scene_index + 1
        WHERE project_id = $1 AND scene_index > $2`,
      [scene.projectId, scene.index],
    );

    await client.query(
      `UPDATE scenes SET end_sec = $2, narration = $3, words = $4::jsonb,
              status = 'planned', image_asset_id = NULL, clip_asset_id = NULL
        WHERE id = $1`,
      [
        scene.id,
        atSec,
        first.map((w) => w.text).join(' ') || scene.narration,
        JSON.stringify(first),
      ],
    );

    const { rows } = await client.query(
      `INSERT INTO scenes (project_id, scene_index, start_sec, end_sec, narration, visual_prompt,
                           negative_prompt, emotion, location, character_ids, camera_motion,
                           motion_prompt, transition_in, is_broll, broll_subject, words)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16::jsonb)
       RETURNING ${COLUMNS}`,
      [
        scene.projectId,
        scene.index + 1,
        atSec,
        scene.endSec,
        second.map((w) => w.text).join(' ') || scene.narration,
        scene.visualPrompt,
        scene.negativePrompt,
        scene.emotion,
        scene.location,
        JSON.stringify(scene.characterIds),
        scene.cameraMotion,
        scene.motionPrompt,
        scene.transitionIn,
        scene.isBroll,
        scene.brollSubject,
        JSON.stringify(second),
      ],
    );

    return [mapScene(rows[0]!)];
  }).then(() => listScenes(scene.projectId));
}

/** Merge a scene into the one before it. */
export async function mergeScene(scene: Scene): Promise<Scene[]> {
  const previous = await queryOne(
    `SELECT ${COLUMNS} FROM scenes WHERE project_id = $1 AND scene_index = $2`,
    [scene.projectId, scene.index - 1],
  );
  if (!previous) throw badRequest('The first scene has nothing to merge into.');

  const target = mapScene(previous);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE scenes SET end_sec = $2, narration = $3, words = $4::jsonb,
              status = 'planned', clip_asset_id = NULL
        WHERE id = $1`,
      [
        target.id,
        scene.endSec,
        `${target.narration} ${scene.narration}`.trim(),
        JSON.stringify([...target.words, ...scene.words]),
      ],
    );
    await client.query('DELETE FROM scenes WHERE id = $1', [scene.id]);
    await client.query(
      `UPDATE scenes SET scene_index = scene_index - 1
        WHERE project_id = $1 AND scene_index > $2`,
      [scene.projectId, scene.index],
    );
  });

  return listScenes(scene.projectId);
}

export async function deleteScene(scene: Scene): Promise<Scene[]> {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM scenes WHERE id = $1', [scene.id]);
    await client.query(
      `UPDATE scenes SET scene_index = scene_index - 1
        WHERE project_id = $1 AND scene_index > $2`,
      [scene.projectId, scene.index],
    );
    // The deleted scene's screen time is absorbed by its neighbour so the
    // timeline stays contiguous with the narration.
    await client.query(
      `UPDATE scenes SET end_sec = $2
        WHERE project_id = $1 AND scene_index = $3`,
      [scene.projectId, scene.endSec, scene.index - 1],
    );
    await client.query(
      `UPDATE scenes SET start_sec = $2
        WHERE project_id = $1 AND scene_index = $3 AND $3 = 0`,
      [scene.projectId, scene.startSec, scene.index],
    );
  });

  return listScenes(scene.projectId);
}

/** Reorder the storyboard, re-timing so scenes still tile the narration. */
export async function reorderScenes(projectId: string, sceneIds: string[]): Promise<Scene[]> {
  const existing = await listScenes(projectId);
  if (existing.length !== sceneIds.length) {
    throw badRequest('The reorder request must list every scene exactly once.');
  }

  const byId = new Map(existing.map((s) => [s.id, s]));
  const ordered = sceneIds.map((id) => {
    const scene = byId.get(id);
    if (!scene) throw badRequest(`Scene ${id} does not belong to this project.`);
    return scene;
  });

  await withTransaction(async (client) => {
    // Two-phase update: negative indices avoid tripping the unique constraint.
    for (let i = 0; i < ordered.length; i += 1) {
      await client.query('UPDATE scenes SET scene_index = $2 WHERE id = $1', [ordered[i]!.id, -(i + 1)]);
    }
    let cursor = 0;
    for (let i = 0; i < ordered.length; i += 1) {
      const scene = ordered[i]!;
      const duration = Math.max(LIMITS.minSceneDurationSec, scene.endSec - scene.startSec);
      await client.query(
        'UPDATE scenes SET scene_index = $2, start_sec = $3, end_sec = $4 WHERE id = $1',
        [scene.id, i, cursor, cursor + duration],
      );
      cursor += duration;
    }
  });

  return listScenes(projectId);
}

/** Adjust a scene's length, sliding every later scene to keep the timeline tight. */
export async function retimeScene(scene: Scene, newDurationSec: number): Promise<Scene[]> {
  const duration = Math.max(LIMITS.minSceneDurationSec, Math.min(LIMITS.maxSceneDurationSec * 4, newDurationSec));
  const delta = duration - (scene.endSec - scene.startSec);
  if (Math.abs(delta) < 0.01) return listScenes(scene.projectId);

  await withTransaction(async (client) => {
    await client.query('UPDATE scenes SET end_sec = start_sec + $2 WHERE id = $1', [scene.id, duration]);
    await client.query(
      `UPDATE scenes SET start_sec = start_sec + $3, end_sec = end_sec + $3
        WHERE project_id = $1 AND scene_index > $2`,
      [scene.projectId, scene.index, delta],
    );
  });

  return listScenes(scene.projectId);
}

/** Scenes that still need media generated. */
export async function pendingScenes(projectId: string, force: boolean): Promise<Scene[]> {
  const scenes = await listScenes(projectId);
  if (force) return scenes;
  return scenes.filter((scene) => !scene.imageAssetId || scene.status === 'failed');
}

export function charactersForScene(
  scene: Scene,
  characters: readonly CharacterProfile[],
): CharacterProfile[] {
  const ids = new Set(scene.characterIds);
  return characters.filter((character) => ids.has(character.id));
}
