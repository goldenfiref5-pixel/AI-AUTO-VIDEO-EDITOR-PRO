import express, { type Express } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { corsOrigins, env, isProduction } from './config/env';
import { logger } from './config/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { buildRouter } from './routes';
import { queryOne } from './db/pool';
import { redis } from './lib/redis';
import { ffmpegAvailable } from './render/ffmpeg';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves media to a separate web origin, so cross-origin reads of
      // generated assets must be permitted.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser callers send no Origin header.
        if (!origin || corsOrigins.includes(origin) || corsOrigins.includes('*')) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
      },
      credentials: true,
    }),
  );

  app.use(
    compression({
      filter: (req, res) => {
        // Compressing an SSE stream defeats its incremental delivery.
        if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        // The progress stream carries its token in the query string, so its
        // URL must never reach the logs.
        ignore: (req) =>
          req.url === '/health' || req.url === '/ready' || (req.url ?? '').includes('/progress'),
      },
    }),
  );

  const limiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    // Long-lived SSE connections are one request; excluding them stops a single
    // open project page from consuming a client's whole budget.
    skip: (req) => req.path.endsWith('/progress'),
    message: { error: { code: 'too_many_requests', message: 'Too many requests. Please slow down.' } },
  });
  app.use('/api', limiter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'aiedit-api', version: '1.0.0' });
  });

  app.get('/ready', async (_req, res) => {
    const [database, cache, ffmpeg] = await Promise.all([
      queryOne('SELECT 1 AS ok').then(() => true).catch(() => false),
      redis.ping().then(() => true).catch(() => false),
      ffmpegAvailable(),
    ]);

    const ready = database && cache;
    res.status(ready ? 200 : 503).json({
      ready,
      checks: { database, redis: cache, ffmpeg },
    });
  });

  app.use('/api', buildRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  if (!isProduction) {
    logger.info({ corsOrigins }, 'CORS origins configured');
  }

  return app;
}
