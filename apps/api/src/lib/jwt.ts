import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { unauthorized } from '../utils/errors';
import type { UserRole } from '@aiedit/shared';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  type: 'access';
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'type'>): string {
  const options: SignOptions = { expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'] };
  return jwt.sign({ ...payload, type: 'access' }, env.JWT_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
    if (decoded.type !== 'access') throw new Error('Wrong token type');
    return decoded;
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

export function accessTokenTtlSeconds(): number {
  const decoded = jwt.decode(signAccessToken({ sub: 'x', email: 'x@x', role: 'user' })) as {
    exp?: number;
    iat?: number;
  } | null;
  if (!decoded?.exp || !decoded.iat) return 3600;
  return decoded.exp - decoded.iat;
}
