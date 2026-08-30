import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { logger } from '../config/logger';
import { isProduction } from '../config/env';
import { GeminiError } from '../gemini/types';
import { HttpError } from '../utils/errors';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'not_found', message: `No route matches ${req.method} ${req.path}` },
  });
}

/** Translate every error shape the app can produce into one JSON envelope. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'validation_error',
        message: 'The request body failed validation.',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That file is larger than this server accepts.'
        : `Upload rejected: ${err.message}`;
    res.status(413).json({ error: { code: 'upload_rejected', message } });
    return;
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) logger.error({ err, path: req.path }, 'Request failed');
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof GeminiError) {
    // A key-level failure reaching this far means the whole pool is exhausted.
    const status = err.keyAtFault ? 503 : err.failureClass === 'safety' ? 422 : 502;
    res.status(status).json({
      error: {
        code: `gemini_${err.failureClass}`,
        message: err.message,
        details: { retryable: err.retryable },
      },
    });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: isProduction
        ? 'Something went wrong on our side. Please try again.'
        : err instanceof Error
          ? err.message
          : String(err),
      ...(isProduction ? {} : { stack: err instanceof Error ? err.stack : undefined }),
    },
  });
}

/** Wrap an async handler so rejected promises reach the error middleware. */
export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
