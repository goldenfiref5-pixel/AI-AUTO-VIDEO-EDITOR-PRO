import { Router } from 'express';
import {
  googleLoginSchema,
  loginSchema,
  registerSchema,
} from '@aiedit/shared';
import { z } from 'zod';
import { env, isProduction } from '../config/env';
import { signAccessToken, accessTokenTtlSeconds } from '../lib/jwt';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { verifyGoogleIdToken } from '../services/googleAuth';
import {
  consumeRefreshToken,
  issueRefreshToken,
  registerUser,
  requireUser,
  revokeAllRefreshTokens,
  upsertGoogleUser,
  verifyCredentials,
} from '../services/users';
import { unauthorized } from '../utils/errors';
import type { Response } from 'express';
import type { User } from '@aiedit/shared';

export const authRouter = Router();

const REFRESH_COOKIE = 'refresh_token';

function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    expires: expiresAt,
    path: '/api/auth',
  });
}

async function issueSession(res: Response, user: User) {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const refresh = await issueRefreshToken(user.id);
  setRefreshCookie(res, refresh.token, refresh.expiresAt);

  return {
    user,
    accessToken,
    expiresIn: accessTokenTtlSeconds(),
    // Also returned in the body so non-browser clients can hold it themselves.
    refreshToken: refresh.token,
  };
}

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const user = await registerUser(input);
    res.status(201).json(await issueSession(res, user));
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = await verifyCredentials(input.email, input.password);
    res.json(await issueSession(res, user));
  }),
);

authRouter.post(
  '/google',
  asyncHandler(async (req, res) => {
    const input = googleLoginSchema.parse(req.body);
    const identity = await verifyGoogleIdToken(input.idToken);
    const user = await upsertGoogleUser({
      googleSub: identity.sub,
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.picture,
    });
    res.json(await issueSession(res, user));
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const body = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
    const token = body.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized('No refresh token was supplied.');

    const user = await consumeRefreshToken(token);
    res.json(await issueSession(res, user));
  }),
);

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await revokeAllRefreshTokens(req.auth!.userId);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await requireUser(req.auth!.userId);
    res.json({ user, googleClientId: env.GOOGLE_CLIENT_ID || null });
  }),
);

/** Public bootstrap info the sign-in screen needs before authenticating. */
authRouter.get('/config', (_req, res) => {
  res.json({
    googleClientId: env.GOOGLE_CLIENT_ID || null,
    passwordLoginEnabled: true,
  });
});
