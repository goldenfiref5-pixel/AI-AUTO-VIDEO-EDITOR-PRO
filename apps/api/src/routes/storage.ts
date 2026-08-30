import { Router } from 'express';
import { env } from '../config/env';
import { authContext, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { storage } from '../lib/storage';
import { assetUrl, requireAsset } from '../services/assets';
import { forbidden, notFound } from '../utils/errors';

export const storageRouter = Router();

/**
 * Local-driver file serving.
 *
 * With STORAGE_DRIVER=s3 the client receives presigned URLs and never touches
 * this route; on local disk it is the only way to read an object back.
 */
storageRouter.get(
  '/storage/*',
  asyncHandler(async (req, res) => {
    if (env.STORAGE_DRIVER !== 'local') {
      throw notFound('Direct storage access is disabled when using object storage.');
    }

    const key = decodeURIComponent(String(req.params[0] ?? ''));
    if (!key || key.includes('..')) throw notFound('Object not found');
    if (!(await storage.exists(key))) throw notFound('Object not found');

    const stream = await storage.getStream(key);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.pipe(res);
  }),
);

/** Authenticated download that resolves an asset id to a URL or a stream. */
storageRouter.get(
  '/assets/:assetId/download',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const asset = await requireAsset(req.params['assetId']!);
    if (asset.userId !== userId && !isAdmin) throw forbidden('This asset belongs to another account.');

    if (env.STORAGE_DRIVER !== 'local') {
      res.redirect(await assetUrl(asset, 3600));
      return;
    }

    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Content-Length', String(asset.bytes));
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(asset.filename)}"`);
    (await storage.getStream(asset.storageKey)).pipe(res);
  }),
);

storageRouter.get(
  '/assets/:assetId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, isAdmin } = authContext(req);
    const asset = await requireAsset(req.params['assetId']!);
    if (asset.userId !== userId && !isAdmin) throw forbidden('This asset belongs to another account.');

    res.json({ asset: { ...asset, url: await assetUrl(asset) } });
  }),
);
