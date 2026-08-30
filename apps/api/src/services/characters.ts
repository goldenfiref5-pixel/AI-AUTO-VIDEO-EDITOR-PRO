import type { CharacterProfile } from '@aiedit/shared';
import { query, queryOne } from '../db/pool';
import { notFound } from '../utils/errors';
import type { PlannedCharacter } from '../pipeline/story';
import { mapCharacter } from './mappers';

const COLUMNS = `id, project_id, name, role, age, gender, skin_tone, hair, face, body_shape,
                 clothing, accessories, voice_tone, canonical_prompt, reference_asset_id, locked,
                 created_at, updated_at`;

export async function listCharacters(projectId: string): Promise<CharacterProfile[]> {
  const rows = await query(
    `SELECT ${COLUMNS} FROM characters WHERE project_id = $1 ORDER BY created_at ASC`,
    [projectId],
  );
  return rows.map(mapCharacter);
}

/**
 * Persist the characters the story planner discovered.
 *
 * Existing characters are updated rather than replaced, and a locked character
 * is left completely untouched — that lock is what keeps a face identical
 * across a re-plan.
 */
export async function upsertCharacters(
  projectId: string,
  planned: readonly PlannedCharacter[],
): Promise<Map<string, CharacterProfile>> {
  const existing = await listCharacters(projectId);
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
  const result = new Map<string, CharacterProfile>();

  for (const character of planned) {
    const key = character.name.toLowerCase();
    const current = byName.get(key);

    if (current?.locked) {
      result.set(key, current);
      continue;
    }

    const row = await queryOne(
      `INSERT INTO characters (project_id, name, role, age, gender, skin_tone, hair, face,
                               body_shape, clothing, accessories, canonical_prompt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (project_id, name) DO UPDATE SET
         role = EXCLUDED.role,
         age = EXCLUDED.age,
         gender = EXCLUDED.gender,
         skin_tone = EXCLUDED.skin_tone,
         hair = EXCLUDED.hair,
         face = EXCLUDED.face,
         body_shape = EXCLUDED.body_shape,
         clothing = EXCLUDED.clothing,
         accessories = EXCLUDED.accessories,
         canonical_prompt = EXCLUDED.canonical_prompt
       RETURNING ${COLUMNS}`,
      [
        projectId,
        character.name,
        character.role,
        character.age,
        character.gender,
        character.skinTone,
        character.hair,
        character.face,
        character.bodyShape,
        character.clothing,
        character.accessories,
        character.canonicalPrompt,
      ],
    );
    result.set(key, mapCharacter(row!));
  }

  return result;
}

export interface CharacterUpdate {
  name?: string;
  role?: string;
  age?: string;
  gender?: string;
  skinTone?: string;
  hair?: string;
  face?: string;
  bodyShape?: string;
  clothing?: string;
  accessories?: string;
  canonicalPrompt?: string;
  locked?: boolean;
  referenceAssetId?: string | null;
}

export async function updateCharacter(
  characterId: string,
  projectId: string,
  update: CharacterUpdate,
): Promise<CharacterProfile> {
  const sets: string[] = [];
  const values: unknown[] = [characterId, projectId];

  const push = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (update.name !== undefined) push('name', update.name);
  if (update.role !== undefined) push('role', update.role);
  if (update.age !== undefined) push('age', update.age);
  if (update.gender !== undefined) push('gender', update.gender);
  if (update.skinTone !== undefined) push('skin_tone', update.skinTone);
  if (update.hair !== undefined) push('hair', update.hair);
  if (update.face !== undefined) push('face', update.face);
  if (update.bodyShape !== undefined) push('body_shape', update.bodyShape);
  if (update.clothing !== undefined) push('clothing', update.clothing);
  if (update.accessories !== undefined) push('accessories', update.accessories);
  if (update.canonicalPrompt !== undefined) push('canonical_prompt', update.canonicalPrompt);
  if (update.locked !== undefined) push('locked', update.locked);
  if (update.referenceAssetId !== undefined) push('reference_asset_id', update.referenceAssetId);

  if (sets.length === 0) {
    const row = await queryOne(`SELECT ${COLUMNS} FROM characters WHERE id = $1 AND project_id = $2`, [
      characterId,
      projectId,
    ]);
    if (!row) throw notFound('Character not found');
    return mapCharacter(row);
  }

  const row = await queryOne(
    `UPDATE characters SET ${sets.join(', ')} WHERE id = $1 AND project_id = $2 RETURNING ${COLUMNS}`,
    values,
  );
  if (!row) throw notFound('Character not found');
  return mapCharacter(row);
}

export async function deleteCharacter(characterId: string, projectId: string): Promise<void> {
  await query('DELETE FROM characters WHERE id = $1 AND project_id = $2', [characterId, projectId]);
}

/**
 * The character sheet is the reference image regenerated for every later scene.
 * Storing it is what turns "describe the same person" into "show this person".
 */
export async function setReferenceAsset(characterId: string, assetId: string): Promise<void> {
  await query('UPDATE characters SET reference_asset_id = $2 WHERE id = $1', [characterId, assetId]);
}
