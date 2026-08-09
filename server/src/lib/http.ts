/**
 * Small request helpers.
 *
 * Express 5 types `req.params` values as `string | string[] | undefined`, because its
 * new router supports repeated and wildcard parameters. For a normal `:id` segment
 * that is never actually an array, but the type is honest and worth handling once
 * here rather than casting at every call site.
 */

import type { Request } from 'express';

import { NotFoundError } from './errors.js';

/** Reads a required path parameter, or 404s if the route somehow matched without it. */
export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  const single = Array.isArray(value) ? value[0] : value;

  if (typeof single !== 'string' || single.length === 0) {
    throw new NotFoundError('Not found.');
  }

  return single;
}
