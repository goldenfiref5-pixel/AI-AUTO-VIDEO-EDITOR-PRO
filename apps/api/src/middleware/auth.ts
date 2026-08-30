import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@aiedit/shared';
import { verifyAccessToken } from '../lib/jwt';
import { forbidden, unauthorized } from '../utils/errors';
import { touchLastSeen } from '../services/users';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; email: string; role: UserRole };
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = req.cookies?.['access_token'];
  return typeof cookie === 'string' && cookie ? cookie : null;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    next(unauthorized('Sign in to continue.'));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub, email: payload.email, role: payload.role };
    // Fire-and-forget: the last-seen timestamp powers the admin "active users"
    // metric and must never delay a request.
    void touchLastSeen(payload.sub);
    next();
  } catch (err) {
    next(err);
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    next();
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub, email: payload.email, role: payload.role };
  } catch {
    // An invalid token on an optional route is simply ignored.
  }
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) {
    next(unauthorized('Sign in to continue.'));
    return;
  }
  if (req.auth.role !== 'admin') {
    next(forbidden('This area is restricted to administrators.'));
    return;
  }
  next();
}

export function authContext(req: Request): { userId: string; role: UserRole; isAdmin: boolean } {
  if (!req.auth) throw unauthorized('Sign in to continue.');
  return { userId: req.auth.userId, role: req.auth.role, isAdmin: req.auth.role === 'admin' };
}
