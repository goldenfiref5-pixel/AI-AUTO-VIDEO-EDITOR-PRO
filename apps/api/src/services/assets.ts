import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Asset, AssetKind } from '@aiedit/shared';
import { env } from '../config/env';
import { query, queryOne } from '../db/pool';
import { buildStorageKey, storage } from '../lib/storage';
import { notFound } from '../utils/errors';
import { mapAsset } from './mappers';

const COLUMNS = `id, project_id, user_id, kind, storage_key, filename, mime_type, bytes,
                 duration_sec, width, height, metadata, created_at`;

export interface CreateAssetInput {
  userId: string;
  projectId: string | null;
  kind: AssetKind;
  filename: string;
  mimeType: string;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  metadata?: Record<string, unknown>;
}

async function insert(input: CreateAssetInput, storageKey: string, bytes: number): Promise<Asset> {
  const row = await queryOne(
    `INSERT INTO assets (project_id, user_id, kind, storage_key, filename, mime_type, bytes,
                         duration_sec, width, height, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING ${COLUMNS}`,
    [
      input.projectId,
      input.userId,
      input.kind,
      storageKey,
      input.filename,
      input.mimeType,
      bytes,
      input.durationSec ?? null,
      input.width ?? null,
      input.height ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return mapAsset(row!);
}

/** Store a file that already exists on local disk (an upload or a render). */
export async function storeFileAsset(input: CreateAssetInput, filePath: string): Promise<Asset> {
  const key = buildStorageKey({
    userId: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    filename: input.filename,
  });
  const stored = await storage.putFile(key, filePath, input.mimeType);
  return insert(input, stored.key, stored.bytes);
}

/** Store bytes produced in memory (generated images, generated clips). */
export async function storeBufferAsset(input: CreateAssetInput, data: Buffer): Promise<Asset> {
  const key = buildStorageKey({
    userId: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    filename: input.filename,
  });
  const stored = await storage.putBuffer(key, data, input.mimeType);
  return insert(input, stored.key, stored.bytes);
}

export async function getAsset(id: string): Promise<Asset | null> {
  const row = await queryOne(`SELECT ${COLUMNS} FROM assets WHERE id = $1`, [id]);
  return row ? mapAsset(row) : null;
}

export async function requireAsset(id: string): Promise<Asset> {
  const asset = await getAsset(id);
  if (!asset) throw notFound(`Asset ${id} not found`);
  return asset;
}

export async function listProjectAssets(projectId: string, kind?: AssetKind): Promise<Asset[]> {
  const rows = kind
    ? await query(
        `SELECT ${COLUMNS} FROM assets WHERE project_id = $1 AND kind = $2 ORDER BY created_at ASC`,
        [projectId, kind],
      )
    : await query(`SELECT ${COLUMNS} FROM assets WHERE project_id = $1 ORDER BY created_at ASC`, [
        projectId,
      ]);
  return rows.map(mapAsset);
}

export async function deleteAsset(id: string): Promise<void> {
  const asset = await getAsset(id);
  if (!asset) return;
  await storage.delete(asset.storageKey).catch(() => undefined);
  await query('DELETE FROM assets WHERE id = $1', [id]);
}

export async function assetBuffer(asset: Asset): Promise<Buffer> {
  return storage.getBuffer(asset.storageKey);
}

/**
 * Materialise an asset on local disk. FFmpeg and the Files API both need real
 * paths, and re-downloading the same asset repeatedly during a render is waste,
 * so the local copy is kept until the caller cleans the work directory.
 */
export async function localCopy(asset: Asset, workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const ext = path.extname(asset.filename) || extensionFor(asset.mimeType);
  const dest = path.join(workDir, `${asset.id}${ext}`);

  try {
    const existing = await stat(dest);
    if (existing.size > 0) return dest;
  } catch {
    // not cached yet
  }

  await storage.downloadTo(asset.storageKey, dest);
  return dest;
}

export function extensionFor(mimeType: string): string {
  const map: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/aac': '.aac',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };
  return map[mimeType] ?? '';
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Signed (or proxied) URL a browser can fetch the asset from. */
export async function assetUrl(asset: Asset, expiresInSec = 3600): Promise<string> {
  return storage.signedUrl(asset.storageKey, expiresInSec);
}

export function uploadTmpDir(): string {
  return path.resolve(env.UPLOAD_TMP_DIR);
}

export function readStream(filePath: string): NodeJS.ReadableStream {
  return createReadStream(filePath);
}
