import crypto from 'node:crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

let cachedKey: Buffer | null = null;

/**
 * Resolve the 32-byte AES key. In development an empty ENCRYPTION_KEY is
 * tolerated by deriving a stable key from JWT_SECRET; production refuses to
 * boot without a real one (see config/env.ts).
 */
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = env.ENCRYPTION_KEY.trim();
  if (!raw) {
    cachedKey = crypto.createHash('sha256').update(`derived:${env.JWT_SECRET}`).digest();
    return cachedKey;
  }

  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, 'hex');
  } else {
    buf = Buffer.from(raw, 'base64');
  }

  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64)');
  }
  cachedKey = buf;
  return cachedKey;
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed encrypted payload');
  }
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Stable, non-reversible identity for a secret — used for dedupe. */
export function fingerprint(value: string): string {
  return crypto.createHmac('sha256', encryptionKey()).update(value).digest('hex').slice(0, 32);
}

/** `AIza••••••••XyZ9` — enough to recognise a key without leaking it. */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 10) return '•'.repeat(Math.max(4, trimmed.length));
  return `${trimmed.slice(0, 6)}${'•'.repeat(8)}${trimmed.slice(-4)}`;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Constant-time string compare that tolerates differing lengths. */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(sha256(a), 'hex');
  const bufB = Buffer.from(sha256(b), 'hex');
  return crypto.timingSafeEqual(bufA, bufB);
}
