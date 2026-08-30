/** Errors that carry an HTTP status all the way to the error middleware. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, 'bad_request', details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, message, 'unauthorized');
export const forbidden = (message = 'You do not have access to this resource') =>
  new HttpError(403, message, 'forbidden');
export const notFound = (message = 'Not found') => new HttpError(404, message, 'not_found');
export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, message, 'conflict', details);
export const payloadTooLarge = (message: string) =>
  new HttpError(413, message, 'payload_too_large');
export const unprocessable = (message: string, details?: unknown) =>
  new HttpError(422, message, 'unprocessable', details);
export const tooManyRequests = (message: string) =>
  new HttpError(429, message, 'too_many_requests');
export const serverError = (message = 'Internal server error', details?: unknown) =>
  new HttpError(500, message, 'internal_error', details);
export const badGateway = (message: string, details?: unknown) =>
  new HttpError(502, message, 'upstream_error', details);
export const serviceUnavailable = (message: string) =>
  new HttpError(503, message, 'service_unavailable');

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
