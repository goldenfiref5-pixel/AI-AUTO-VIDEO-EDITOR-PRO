import bcrypt from 'bcryptjs';
import type { User } from '@aiedit/shared';
import { query, queryOne } from '../db/pool';
import { conflict, notFound, unauthorized } from '../utils/errors';
import { randomToken, sha256 } from '../utils/crypto';
import { mapUser } from './mappers';

const COLUMNS = `id, email, name, avatar_url, role, created_at`;

const BCRYPT_ROUNDS = 12;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const row = await queryOne(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [normalizeEmail(email)]);
  return row ? mapUser(row) : null;
}

export async function getUser(id: string): Promise<User | null> {
  const row = await queryOne(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  return row ? mapUser(row) : null;
}

export async function requireUser(id: string): Promise<User> {
  const user = await getUser(id);
  if (!user) throw notFound('User not found');
  return user;
}

export async function registerUser(params: {
  email: string;
  password: string;
  name?: string;
}): Promise<User> {
  const email = normalizeEmail(params.email);
  const existing = await findUserByEmail(email);
  if (existing) throw conflict('An account already exists for this email address.');

  const passwordHash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);

  // The first account to register owns the instance and becomes its admin.
  const countRow = await queryOne<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  const role = Number(countRow?.count ?? 0) === 0 ? 'admin' : 'user';

  const row = await queryOne(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING ${COLUMNS}`,
    [email, passwordHash, params.name ?? null, role],
  );
  return mapUser(row!);
}

export async function verifyCredentials(email: string, password: string): Promise<User> {
  const row = await queryOne<{ id: string; password_hash: string | null }>(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [normalizeEmail(email)],
  );

  // Always run a hash comparison so a missing account and a wrong password take
  // the same amount of time.
  const hash = row?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const ok = await bcrypt.compare(password, hash);

  if (!row || !row.password_hash || !ok) {
    throw unauthorized('Incorrect email or password.');
  }
  return requireUser(row.id);
}

/** Find or create the local account backing a verified Google identity. */
export async function upsertGoogleUser(params: {
  googleSub: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}): Promise<User> {
  const email = normalizeEmail(params.email);

  const bySub = await queryOne(`SELECT ${COLUMNS} FROM users WHERE google_sub = $1`, [params.googleSub]);
  if (bySub) {
    await query('UPDATE users SET name = COALESCE($2, name), avatar_url = COALESCE($3, avatar_url) WHERE id = $1', [
      (bySub as { id: string }).id,
      params.name,
      params.avatarUrl,
    ]);
    return mapUser(bySub);
  }

  const countRow = await queryOne<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  const role = Number(countRow?.count ?? 0) === 0 ? 'admin' : 'user';

  const row = await queryOne(
    `INSERT INTO users (email, google_sub, name, avatar_url, role)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE SET
       google_sub = COALESCE(users.google_sub, EXCLUDED.google_sub),
       name = COALESCE(users.name, EXCLUDED.name),
       avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url)
     RETURNING ${COLUMNS}`,
    [email, params.googleSub, params.name, params.avatarUrl, role],
  );
  return mapUser(row!);
}

export async function touchLastSeen(userId: string): Promise<void> {
  await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]).catch(() => undefined);
}

export interface RefreshTokenPair {
  token: string;
  expiresAt: Date;
}

/**
 * Refresh tokens are stored hashed so a database leak cannot be replayed
 * against the API.
 */
export async function issueRefreshToken(userId: string, ttlDays = 30): Promise<RefreshTokenPair> {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);

  await query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [
    userId,
    sha256(token),
    expiresAt,
  ]);

  return { token, expiresAt };
}

export async function consumeRefreshToken(token: string): Promise<User> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM refresh_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256(token)],
  );
  if (!row) throw unauthorized('This session has expired. Please sign in again.');

  // Single-use rotation: the presented token is revoked as it is exchanged.
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
  return requireUser(row.user_id);
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
}

export async function isAdmin(userId: string): Promise<boolean> {
  const row = await queryOne<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
  return row?.role === 'admin';
}
