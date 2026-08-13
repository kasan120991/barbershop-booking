/**
 * Authorization guards. These reject; `authenticate` only resolves.
 *
 * Each returns a middleware so routes read as a sentence:
 *   router.post('/devices', requireRole(ROLE.ADMIN), handler)
 */

import { ROLE } from '@francis/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { DeviceType, Role } from '../generated/prisma/enums.js';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors.js';

/** Any signed-in staff member. */
export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth?.kind !== 'user') {
    next(new UnauthenticatedError('You must be signed in to do that.'));
    return;
  }
  next();
}

/**
 * Requires at least one of the given roles.
 *
 * A device principal can never satisfy this — it has no roles, so a kiosk cannot
 * reach an admin route even if someone puts a device token on the request.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (req.auth?.kind !== 'user') {
      next(new UnauthenticatedError('You must be signed in to do that.'));
      return;
    }

    if (!roles.some((role) => req.auth?.kind === 'user' && req.auth.roles.includes(role))) {
      next(new ForbiddenError('You do not have access to that.'));
      return;
    }

    next();
  };
}

export const requireAdmin: RequestHandler = requireRole(ROLE.ADMIN as Role);

/**
 * A paired device, optionally narrowed to specific types.
 *
 * Variadic rather than a single optional type because there are now three kinds and the
 * useful guards are subsets: the redacted board is for the two screens, the voice webhook
 * is for the phone line alone. `requireDevice()` with no argument still means "any
 * device", but reach for it only when a route genuinely serves all three — a guard that
 * names its types stays correct when a fourth kind is added, and one that does not
 * silently widens.
 */
export function requireDevice(...types: DeviceType[]): RequestHandler {
  return (req, _res, next) => {
    if (req.auth?.kind !== 'device') {
      next(new UnauthenticatedError('This device is not paired.'));
      return;
    }

    if (types.length > 0 && !types.includes(req.auth.deviceType)) {
      next(new ForbiddenError('This device is not allowed to do that.'));
      return;
    }

    next();
  };
}

/**
 * The same rule as `requireBarberSelfOrAdmin`, for routes that cannot know the barber
 * until they have read something.
 *
 * Cancelling a payment names the *payment*, and whose chair it belongs to is a database
 * lookup away — which a middleware taking a synchronous getter cannot do. Rather than
 * letting such a route fall back to a weaker check, it loads the owner and calls this.
 * One rule, two entry points.
 */
export function assertBarberSelfOrAdmin(req: Request, barberId: string): void {
  if (req.auth?.kind !== 'user') throw new UnauthenticatedError();
  if (req.auth.roles.includes(ROLE.ADMIN as Role)) return;
  if (req.auth.barberId !== null && req.auth.barberId === barberId) return;

  throw new ForbiddenError('You can only access your own records.');
}

/**
 * Guards resources that belong to one barber.
 *
 * An ADMIN passes for anyone; a BARBER passes only for their own id. This is the
 * check that keeps one barber out of another's earnings, payouts, and rent.
 */
export function requireBarberSelfOrAdmin(getBarberId: (req: Request) => string): RequestHandler {
  return (req, _res, next) => {
    if (req.auth?.kind !== 'user') {
      next(new UnauthenticatedError('You must be signed in to do that.'));
      return;
    }

    if (req.auth.roles.includes(ROLE.ADMIN as Role)) {
      next();
      return;
    }

    if (req.auth.barberId !== null && req.auth.barberId === getBarberId(req)) {
      next();
      return;
    }

    next(new ForbiddenError('You can only access your own records.'));
  };
}
