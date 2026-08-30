import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { closePool } from './db/pool';
import { closeRedis } from './lib/redis';
import { runMigrations } from './db/migrate';
import { closeProgress } from './services/progress';
import { closeQueues } from './queue/queues';
import { ffmpegAvailable } from './render/ffmpeg';

async function main(): Promise<void> {
  // Running migrations at boot keeps a single-container deployment honest; in a
  // multi-replica setup the advisory lock inside PostgreSQL serialises them.
  await runMigrations();

  if (!(await ffmpegAvailable())) {
    logger.warn(
      { ffmpegPath: env.FFMPEG_PATH },
      'FFmpeg was not found — uploads cannot be probed and rendering will fail',
    );
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  // Renders and uploads can hold a connection for a long time.
  server.requestTimeout = 30 * 60_000;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down API');
    server.close();
    await closeProgress();
    await closeQueues();
    await closeRedis();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'API failed to start');
  process.exit(1);
});
