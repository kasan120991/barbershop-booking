/**
 * Who is on the other end of a socket.
 *
 * Resolution goes through exactly the same functions as the HTTP middleware, in the
 * same order — session cookie first, then device token — because two implementations
 * of "who is this" is how a revoked session keeps working on one transport and not the
 * other. See `middleware/authenticate.ts`; this file is its socket twin.
 *
 * Two differences are forced by the transport, not chosen:
 *
 * - A browser cannot set a custom header on a WebSocket upgrade, so a device presents
 *   its token through `io(url, { auth: { deviceToken } })` and it arrives on
 *   `handshake.auth` rather than as `x-device-token`.
 * - `handshake.headers.cookie` is a raw string, so it goes through `parseCookieHeader`
 *   rather than `cookie-parser`, which only exists as Express middleware.
 *
 * And one difference that IS a choice: unlike `authenticate`, which resolves and never
 * rejects, this **rejects**. An HTTP request with no session may still be a legitimate
 * public booking; a socket with no identity has no room to join and nothing to receive,
 * so holding the connection open would only cost a file descriptor.
 */

import type { Socket } from 'socket.io';

import { DEVICE_TOKEN_HEADER, SESSION_COOKIE } from '../config/constants.js';
import { parseCookieHeader } from '../lib/cookies.js';
import type { AuthPrincipal } from '../middleware/authenticate.js';
import { resolveDeviceToken, touchDevice } from '../services/devices.js';
import { resolveSession, touchSession } from '../services/sessions.js';

/** Pulls a device token from the handshake, whichever way the client could send it. */
function deviceTokenFrom(socket: Socket): string | null {
  const fromAuth = (socket.handshake.auth as { deviceToken?: unknown }).deviceToken;
  if (typeof fromAuth === 'string' && fromAuth !== '') return fromAuth;

  // A non-browser client (a test, or a native display) can still send the header, so
  // the HTTP form is accepted too rather than being a second thing to remember.
  const fromHeader = socket.handshake.headers[DEVICE_TOKEN_HEADER];
  const header = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  return typeof header === 'string' && header !== '' ? header : null;
}

/** Resolves the connection to a principal, or null if it cannot be identified. */
export async function resolveSocketPrincipal(socket: Socket): Promise<AuthPrincipal | null> {
  // Session first, exactly as the HTTP middleware does: a signed-in barber using the
  // shop tablet is themselves, not the kiosk.
  const cookies = parseCookieHeader(socket.handshake.headers.cookie);
  const sessionToken = cookies[SESSION_COOKIE];

  if (typeof sessionToken === 'string' && sessionToken !== '') {
    const session = await resolveSession(sessionToken);
    if (session) {
      touchSession(session.sessionId);
      return {
        kind: 'user',
        userId: session.userId,
        sessionId: session.sessionId,
        roles: session.roles,
        barberId: session.barberId,
        csrfTokenHash: session.csrfTokenHash,
        mustChangePassword: session.mustChangePassword,
      };
    }
  }

  const deviceToken = deviceTokenFrom(socket);
  if (deviceToken !== null) {
    const device = await resolveDeviceToken(deviceToken);
    if (device) {
      touchDevice(device.deviceId);
      return {
        kind: 'device',
        deviceId: device.deviceId,
        label: device.label,
        deviceType: device.type,
      };
    }
  }

  return null;
}
