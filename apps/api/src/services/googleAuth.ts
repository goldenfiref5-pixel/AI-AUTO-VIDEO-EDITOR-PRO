import crypto from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { badRequest, unauthorized } from '../utils/errors';

interface GoogleJwk {
  kid: string;
  n: string;
  e: string;
  alg: string;
  kty: string;
  use: string;
}

interface CachedKeys {
  keys: Map<string, crypto.KeyObject>;
  expiresAt: number;
}

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

let cache: CachedKeys | null = null;

async function googleKeys(): Promise<Map<string, crypto.KeyObject>> {
  if (cache && cache.expiresAt > Date.now()) return cache.keys;

  const response = await fetch(JWKS_URL);
  if (!response.ok) throw unauthorized('Could not reach Google to verify the sign-in.');

  const body = (await response.json()) as { keys: GoogleJwk[] };
  const keys = new Map<string, crypto.KeyObject>();

  for (const jwk of body.keys) {
    if (jwk.kty !== 'RSA') continue;
    try {
      keys.set(jwk.kid, crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' }));
    } catch (err) {
      logger.warn({ err, kid: jwk.kid }, 'Skipping an unusable Google signing key');
    }
  }

  // Respect Google's cache-control, defaulting to an hour.
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  cache = { keys, expiresAt: Date.now() + maxAge * 1000 };
  return keys;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/**
 * Verify a Google ID token locally: signature against Google's JWKS, then the
 * issuer, audience and expiry claims. Doing it in-process avoids a network
 * round trip per sign-in and avoids trusting an unverified payload.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw badRequest('Google sign-in is not configured on this server (GOOGLE_CLIENT_ID is unset).');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) throw unauthorized('Malformed Google ID token.');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: { kid?: string; alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    throw unauthorized('Malformed Google ID token.');
  }

  if (header.alg !== 'RS256' || !header.kid) throw unauthorized('Unsupported Google token algorithm.');

  const key = (await googleKeys()).get(header.kid);
  if (!key) throw unauthorized('Google signing key not recognised. Try signing in again.');

  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerPart}.${payloadPart}`),
    key,
    Buffer.from(signaturePart, 'base64url'),
  );
  if (!verified) throw unauthorized('Google ID token signature is invalid.');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload['exp'] === 'number' && payload['exp'] < now) {
    throw unauthorized('Google ID token has expired.');
  }
  if (typeof payload['iss'] !== 'string' || !ISSUERS.has(payload['iss'])) {
    throw unauthorized('Google ID token has an unexpected issuer.');
  }
  if (payload['aud'] !== env.GOOGLE_CLIENT_ID) {
    throw unauthorized('Google ID token was issued for a different application.');
  }

  const email = typeof payload['email'] === 'string' ? payload['email'] : '';
  if (!email) throw unauthorized('Google account did not provide an email address.');
  if (payload['email_verified'] === false) {
    throw unauthorized('This Google account has an unverified email address.');
  }

  return {
    sub: String(payload['sub']),
    email,
    emailVerified: payload['email_verified'] !== false,
    name: typeof payload['name'] === 'string' ? payload['name'] : null,
    picture: typeof payload['picture'] === 'string' ? payload['picture'] : null,
  };
}
