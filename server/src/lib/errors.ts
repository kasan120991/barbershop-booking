/**
 * Application errors.
 *
 * Services throw these; the error handler turns them into the `ApiError` envelope
 * from `@francis/shared`. Because services are plain functions with no Express
 * coupling, they must not know about status codes directly — `AppError` carries
 * the status so the same thrown error works over REST today and over the Vapi
 * voice router later.
 */

import { ERROR_CODE, type ErrorCode, type FieldErrors } from '@francis/shared';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** True when the message is safe to show a user. False means the handler substitutes a generic one. */
  readonly expose: boolean;
  readonly fields: FieldErrors | undefined;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: { expose?: boolean; fields?: FieldErrors; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.expose = options.expose ?? true;
    this.fields = options.fields;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The submitted data is invalid.', fields?: FieldErrors) {
    super(ERROR_CODE.VALIDATION_FAILED, 400, message, fields === undefined ? {} : { fields });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'You must be signed in to do that.') {
    super(ERROR_CODE.UNAUTHENTICATED, 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to that.') {
    super(ERROR_CODE.FORBIDDEN, 403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super(ERROR_CODE.NOT_FOUND, 404, message);
  }
}

/**
 * A conflicting write — the double-booking guard is the canonical case, where the
 * overlap re-check inside the row lock finds the slot was taken first.
 */
export class ConflictError extends AppError {
  constructor(message = 'That conflicts with something already booked.') {
    super(ERROR_CODE.CONFLICT, 409, message);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests. Please wait and try again.') {
    super(ERROR_CODE.RATE_LIMITED, 429, message);
  }
}

/** An unexpected failure. Never exposed — the real message goes to the log only. */
export class InternalError extends AppError {
  constructor(message = 'Something went wrong.', cause?: unknown) {
    super(ERROR_CODE.INTERNAL, 500, message, { expose: false, ...(cause === undefined ? {} : { cause }) });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
