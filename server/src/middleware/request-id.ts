/**
 * Assigns `req.requestId` and echoes it as `x-request-id`.
 *
 * Must be the first middleware mounted: the request logger reads this value so a
 * log line and its error response share one id, and an upstream proxy's id is
 * honoured so a trace survives the hop.
 */

import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

/** Bound so a hostile client cannot write an arbitrarily long string into every log line. */
const MAX_UPSTREAM_ID_LENGTH = 128;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-request-id'];
  const upstream = (Array.isArray(header) ? header[0] : header)?.trim();

  const id = upstream && upstream.length <= MAX_UPSTREAM_ID_LENGTH ? upstream : randomUUID();

  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
