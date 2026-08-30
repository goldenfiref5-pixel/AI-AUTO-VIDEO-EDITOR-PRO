import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { notFound } from '../utils/errors';

export interface StoredObject {
  key: string;
  bytes: number;
  mimeType: string;
}

export interface StorageDriver {
  readonly name: 'local' | 's3';
  putFile(key: string, filePath: string, mimeType: string): Promise<StoredObject>;
  putBuffer(key: string, data: Buffer, mimeType: string): Promise<StoredObject>;
  getBuffer(key: string): Promise<Buffer>;
  /** Materialise an object on local disk — FFmpeg needs real file paths. */
  downloadTo(key: string, destPath: string): Promise<string>;
  getStream(key: string): Promise<NodeJS.ReadableStream>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, expiresInSec?: number): Promise<string>;
}

function sanitizeKey(key: string): string {
  const normalized = path.posix.normalize(key).replace(/^(\.\.(\/|$))+/, '');
  if (normalized.startsWith('/') || normalized.includes('..')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
  return normalized;
}

class LocalStorage implements StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const full = path.join(this.root, sanitizeKey(key));
    if (!full.startsWith(this.root)) throw new Error(`Unsafe storage key: ${key}`);
    return full;
  }

  async putFile(key: string, filePath: string, mimeType: string): Promise<StoredObject> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(createReadStream(filePath), createWriteStream(dest));
    const info = await stat(dest);
    return { key, bytes: info.size, mimeType };
  }

  async putBuffer(key: string, data: Buffer, mimeType: string): Promise<StoredObject> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
    return { key, bytes: data.byteLength, mimeType };
  }

  async getBuffer(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      throw notFound(`Object not found: ${key}`);
    }
  }

  async downloadTo(key: string, destPath: string): Promise<string> {
    await mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(createReadStream(this.resolve(key)), createWriteStream(destPath));
    return destPath;
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    if (!(await this.exists(key))) throw notFound(`Object not found: ${key}`);
    return createReadStream(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  /**
   * Local mode has no object store to sign against, so downloads are proxied
   * through the API's own `/api/assets/:id/download` route.
   */
  async signedUrl(key: string): Promise<string> {
    return `${env.API_PUBLIC_URL}/api/storage/${encodeURI(sanitizeKey(key))}`;
  }
}

class S3Storage implements StorageDriver {
  readonly name = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  async putFile(key: string, filePath: string, mimeType: string): Promise<StoredObject> {
    const info = await stat(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: sanitizeKey(key),
        Body: createReadStream(filePath),
        ContentType: mimeType,
        ContentLength: info.size,
      }),
    );
    return { key, bytes: info.size, mimeType };
  }

  async putBuffer(key: string, data: Buffer, mimeType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: sanitizeKey(key),
        Body: data,
        ContentType: mimeType,
        ContentLength: data.byteLength,
      }),
    );
    return { key, bytes: data.byteLength, mimeType };
  }

  private async body(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }),
    );
    if (!result.Body) throw notFound(`Object not found: ${key}`);
    return result.Body as Readable;
  }

  async getBuffer(key: string): Promise<Buffer> {
    const stream = await this.body(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  async downloadTo(key: string, destPath: string): Promise<string> {
    await mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(await this.body(key), createWriteStream(destPath));
    return destPath;
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    return this.body(key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: sanitizeKey(key) }));
  }

  async signedUrl(key: string, expiresInSec = 3600): Promise<string> {
    const safe = sanitizeKey(key);
    if (env.S3_PUBLIC_BASE_URL) {
      return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${encodeURI(safe)}`;
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: safe }),
      { expiresIn: expiresInSec },
    );
  }
}

export const storage: StorageDriver =
  env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage(env.STORAGE_LOCAL_DIR);

logger.info({ driver: storage.name }, 'Storage driver initialised');

/** Deterministic, collision-resistant object keys grouped by project. */
export function buildStorageKey(parts: {
  userId: string;
  projectId?: string | null;
  kind: string;
  filename: string;
}): string {
  const ext = path.extname(parts.filename).toLowerCase().slice(0, 12) || '';
  const base = path
    .basename(parts.filename, path.extname(parts.filename))
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 60);
  const unique = crypto.randomBytes(8).toString('hex');
  const scope = parts.projectId ? `projects/${parts.projectId}` : `users/${parts.userId}`;
  return `${scope}/${parts.kind}/${Date.now()}-${unique}-${base}${ext}`;
}
