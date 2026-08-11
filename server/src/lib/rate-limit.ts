/**
 * Rate limiters that speak the same error envelope as everything else.
 *
 * `express-rate-limit` answers a 429 with its own plain-text body, which never reaches
 * `errorHandler` and therefore never becomes `{ error: { code, message, requestId } }`.
 * Both frontends parse that envelope in `toApiFailure` and fall through to
 * `code: 'NETWORK'` when it is missing — so a rate-limited client tells the user
 * *"Could not reach the shop"* while the server is perfectly reachable and deliberately
 * refusing them.
 *
 * That is worst exactly where it is most likely: the kiosk, where five joins an hour per
 * phone is a rule somebody will hit with nobody standing there to explain it.
 *
 * `RateLimitedError` has existed since the error module was written and nothing ever
 * constructed it. This is what constructs it.
 */

import type { RequestHandler } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';

import { isTest } from '../config/env.js';
import { RateLimitedError } from './errors.js';

/**
 * The 429 handler, exported so it can be tested.
 *
 * The limiters themselves `skip` under test, so a test that went through one would be
 * testing the skip. This is the piece that was actually broken, and it is testable on
 * its own: hand it to `next` and the shared error handler does the rest.
 */
export function rateLimitHandler(message: string): RequestHandler {
  return (_req, _res, next) => {
    next(new RateLimitedError(message));
  };
}

/**
 * Builds a limiter with the shared defaults.
 *
 * `skip` under test is not laziness: the suite fires hundreds of requests from one
 * address and would trip every limit, testing the limiter instead of the route.
 */
export function limiter(options: {
  windowMs: number;
  limit: number;
  message: string;
  keyGenerator?: Options['keyGenerator'];
  /**
   * An extra reason to let a request past, ORed with the test skip.
   *
   * Callers must not pass `skip` themselves — it would replace the test skip rather
   * than add to it, and the whole suite would start tripping limits.
   */
  skipWhen?: (req: Parameters<NonNullable<Options['skip']>>[0]) => boolean;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => isTest || (options.skipWhen?.(req) ?? false),
    ...(options.keyGenerator === undefined ? {} : { keyGenerator: options.keyGenerator }),
    /**
     * Handed to `next` rather than written directly, so the response goes through the
     * one place an error becomes HTTP and picks up the request id with it.
     */
    handler: rateLimitHandler(options.message),
  });
}
