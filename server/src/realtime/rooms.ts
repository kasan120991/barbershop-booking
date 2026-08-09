/**
 * Which rooms a connection belongs in.
 *
 * The room is the privacy boundary, so it is decided once, here, from the principal —
 * never from anything the client asks for. `ClientToServerEvents` is empty precisely so
 * there is no "join this room" message to forge.
 */

import { barberRoom, SOCKET_ROOM } from '@francis/shared';

import type { AuthPrincipal } from '../middleware/authenticate.js';

export function roomsFor(principal: AuthPrincipal): string[] {
  if (principal.kind === 'user') {
    return [
      SOCKET_ROOM.shop,
      /**
       * Joined now although nothing is emitted to it this phase. A barber-specific
       * event later — their own client arriving, their own payment clearing — then
       * costs an emit rather than a reconnect on every open tab in the shop.
       */
      ...(principal.barberId === null ? [] : [barberRoom(principal.barberId)]),
    ];
  }

  // A device gets exactly one room, and never `shop`. That is what stops a paired
  // tablet on the counter from receiving phone numbers.
  return [principal.deviceType === 'KIOSK' ? SOCKET_ROOM.kiosk : SOCKET_ROOM.display];
}
