import { DEFAULT_PROJECT_SETTINGS, captionPreset } from '@aiedit/shared';
import { logger } from '../config/logger';
import { closePool } from './pool';
import { runMigrations } from './migrate';
import { createProject } from '../services/projects';
import { createTemplate } from '../services/templates';
import { findUserByEmail, registerUser } from '../services/users';

const DEMO_EMAIL = 'demo@aiautoeditor.local';
const DEMO_PASSWORD = 'ChangeMeDemo2024!';

/**
 * Create a first admin account plus a starter set of templates so a fresh
 * install has something to look at. Safe to run repeatedly.
 */
async function seed(): Promise<void> {
  await runMigrations();

  let user = await findUserByEmail(DEMO_EMAIL);
  if (!user) {
    user = await registerUser({ email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Demo Producer' });
    logger.info({ email: DEMO_EMAIL, password: DEMO_PASSWORD }, 'Created the demo account');
  } else {
    logger.info({ email: DEMO_EMAIL }, 'Demo account already exists');
  }

  const project = await createProject({
    userId: user.id,
    name: 'Sample Vertical Story',
    videoTitle: 'The Treasure Map',
    aspectRatio: '9:16',
    targetDurationSec: 60,
    language: 'en',
    settings: DEFAULT_PROJECT_SETTINGS,
  });
  logger.info({ projectId: project.id }, 'Created a sample project');

  for (const style of ['tiktok', 'reels', 'documentary', 'cinematic'] as const) {
    await createTemplate({
      userId: user.id,
      kind: 'caption_preset',
      name: `${style[0]!.toUpperCase()}${style.slice(1)} captions`,
      description: `Built-in ${style} caption styling.`,
      payload: captionPreset(style) as unknown as Record<string, unknown>,
    });
  }

  await createTemplate({
    userId: user.id,
    kind: 'export_preset',
    name: '1080p vertical, 30fps MP4',
    description: 'The default short-form delivery spec.',
    payload: { format: 'mp4', resolution: '1080p', fps: 30, videoBitrateKbps: null, audioBitrateKbps: 192 },
  });

  logger.info('Seed complete');
}

seed()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'Seed failed');
    process.exit(1);
  });
