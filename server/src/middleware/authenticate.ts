/**
 * Resolves whoever is calling onto `req.auth`.
 *
 * Never rejects — an anonymous request is legitimate (public booking, the login route
 * itself). Enforcement lives in `require-auth.ts`.
 *
 * Two principals, modelled as a discriminated union rather than a bag of optional
 * fields. That is deliberate: with a union, `requireRole('ADMIN')` cannot be
 * accidentally satisfied by a kiosk tablet, because a device principal has no `roles`
 * property at all and the compiler says so.
 */

import type { NextFunction, Request, Response } from 'express';

import { SESSION_COOKIE, DEVICE_TOKEN_HEADER } from '../config/constants.js';
import type { DeviceType } from '../generated/prisma/enums.js';
import type { Role } from '../generated/prisma/enums.js';
import { resolveDeviceToken, touchDevice } from '../services/devices.js';
import { resolveSession, touchSession } from '../services/sessions.js';

export type AuthPrincipal =
  | {
      kind: 'user';
      userId: string;
      sessionId: string;
      roles: Role[];
      /** Non-null when this user also cuts hair. */
      barberId: string | null;
      csrfTokenHash: string;
      mustChangePassword: boolean;
    }
  | {
      kind: 'device';
      deviceId: string;
      label: string;
      deviceType: DeviceType;
    };

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  // A staff session takes precedence: if a barber is signed in on the shop tablet,
  // they should act as themselves rather than as the anonymous kiosk.
  const sessionToken: unknown = req.cookies?.[SESSION_COOKIE];

  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    const session = await resolveSession(sessionToken);
    if (session) {
      req.auth = {
        kind: 'user',
        userId: session.userId,
        sessionId: session.sessionId,
        roles: session.roles,
        barberId: session.barberId,
        csrfTokenHash: session.csrfTokenHash,
        mustChangePassword: session.mustChangePassword,
      };
      touchSession(session.sessionId);
      next();
      return;
    }
  }

  const deviceHeader = req.headers[DEVICE_TOKEN_HEADER];
  const deviceToken = Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader;

  if (typeof deviceToken === 'string' && deviceToken.length > 0) {
    const device = await resolveDeviceToken(deviceToken);
    if (device) {
      req.auth = {
        kind: 'device',
        deviceId: device.deviceId,
        label: device.label,
        deviceType: device.type,
      };
      touchDevice(device.deviceId);
    }
  }

  next();
}
