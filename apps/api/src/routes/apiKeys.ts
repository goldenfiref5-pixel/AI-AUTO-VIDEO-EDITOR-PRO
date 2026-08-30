import { Router } from 'express';
import {
  createApiKeySchema,
  keyPoolSettingsSchema,
  reorderApiKeysSchema,
  updateApiKeySchema,
} from '@aiedit/shared';
import { authContext, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { getKeyPoolSettings, setKeyPoolSettings, testApiKey } from '../gemini/keyPool';
import {
  createApiKey,
  deleteApiKey,
  keyPoolHealth,
  listApiKeys,
  listKeyEvents,
  reorderApiKeys,
  updateApiKey,
} from '../services/apiKeys';

export const apiKeysRouter = Router();

apiKeysRouter.use(requireAuth);

apiKeysRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    res.json({
      keys: await listApiKeys(userId),
      settings: await getKeyPoolSettings(userId),
      health: await keyPoolHealth(userId),
    });
  }),
);

apiKeysRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const input = createApiKeySchema.parse(req.body);
    const key = await createApiKey({ userId, ...input });

    // Test immediately so the row never sits in the UI as "untested".
    const test = await testApiKey(key.id, userId).catch(() => null);
    const [refreshed] = await listApiKeys(userId).then((keys) => keys.filter((k) => k.id === key.id));

    res.status(201).json({ key: refreshed ?? key, test });
  }),
);

apiKeysRouter.patch(
  '/:keyId',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const input = updateApiKeySchema.parse(req.body);
    res.json({ key: await updateApiKey(req.params['keyId']!, userId, input) });
  }),
);

apiKeysRouter.delete(
  '/:keyId',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    await deleteApiKey(req.params['keyId']!, userId);
    res.status(204).end();
  }),
);

/** The Test API button: performs a real Gemini request against this key. */
apiKeysRouter.post(
  '/:keyId/test',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const result = await testApiKey(req.params['keyId']!, userId);
    res.json({ result });
  }),
);

apiKeysRouter.post(
  '/test-all',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const keys = await listApiKeys(userId);

    // Sequential on purpose: a burst of probes across many keys is exactly the
    // pattern that trips Google's per-project rate limits.
    const results = [];
    for (const key of keys) {
      results.push(await testApiKey(key.id, userId));
    }

    res.json({ results, keys: await listApiKeys(userId) });
  }),
);

apiKeysRouter.post(
  '/reorder',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const { keyIds } = reorderApiKeysSchema.parse(req.body);
    res.json({ keys: await reorderApiKeys(userId, keyIds) });
  }),
);

apiKeysRouter.get(
  '/:keyId/events',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    res.json({ events: await listKeyEvents(req.params['keyId']!, userId) });
  }),
);

apiKeysRouter.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    res.json({ settings: await getKeyPoolSettings(userId) });
  }),
);

apiKeysRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const { userId } = authContext(req);
    const settings = keyPoolSettingsSchema.parse(req.body);
    res.json({ settings: await setKeyPoolSettings(userId, settings) });
  }),
);
