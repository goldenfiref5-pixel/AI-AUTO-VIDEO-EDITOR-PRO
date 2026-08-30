import pino from 'pino';
import { env, isProduction } from './env';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Pretty output is a dev nicety only; production emits newline-delimited JSON.
  transport: isProduction
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 },
      },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'apiKey',
      '*.apiKey',
      'key',
      '*.key',
      'password',
      '*.password',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
