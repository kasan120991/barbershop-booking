/**
 * The single place an error becomes an HTTP response.
 *
 * Express 5 forwards rejected promises from async handlers here automatically, so
 * route handlers do not need try/catch just to report failure.
 *
 * The rule that matters: a 5xx never leaks its message to the client. Internal
 * messages routinely contain SQL fragments, file paths, and Stripe internals. The
 * client gets a generic message plus a `requestId` that ties it to the full log line.
 */

import { ERROR_CODE, type ApiError } from '@francis/shared';
import type { NextFunction, Request, Response } from 'express';
import { ZodError, z } from 'zod';

import { isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiError = {
    error: {
      code: ERROR_CODE.NOT_FOUND,
      message: `Cannot ${req.method} ${req.path}`,
      requestId: req.requestId,
    },
  };
  res.status(404).json(body);
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Headers already sent means a response is mid-flight; only Express can clean this up.
  if (res.headersSent) {
    next(error);
    return;
  }

  const requestId = req.requestId;

  // A zod error that reaches here escaped a validation middleware — still report it usefully.
  if (error instanceof ZodError) {
    const { fieldErrors } = z.flattenError(error);
    logger.warn({ err: error, requestId }, 'Request failed validation');
    res.status(400).json({
      error: {
        code: ERROR_CODE.VALIDATION_FAILED,
        message: 'The submitted data is invalid.',
        fields: fieldErrors,
        requestId,
      },
    } satisfies ApiError);
    return;
  }

  if (isAppError(error)) {
    const level = error.status >= 500 ? 'error' : 'warn';
    logger[level]({ err: error, requestId, code: error.code }, error.message);

    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.expose ? error.message : 'Something went wrong.',
        ...(error.fields === undefined ? {} : { fields: error.fields }),
        requestId,
      },
    } satisfies ApiError);
    return;
  }

  logger.error({ err: error, requestId }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: ERROR_CODE.INTERNAL,
      message: 'Something went wrong.',
      requestId,
    },
  } satisfies ApiError);
}
