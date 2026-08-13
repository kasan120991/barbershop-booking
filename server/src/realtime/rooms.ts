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
       * Joined, and still nothing is emitted to it.
       *
       * `appointment:changed` was the obvious first user and deliberately declined it: a
       * barber is in `shop` too, so emitting to both delivers one change twice, and a
       * cross-chair reschedule would be two emits for one fact. It carries every affected
       * chair in its payload and the barber-scoped pages filter on that instead —
       * `realtime.test.ts` pins the single delivery so nobody "improves" it back.
       *
       * The room still earns its place for something only one barber may see, where the
       * payload itself would be wrong to put in front of the shop.
       */
      ...(principal.barberId === null ? [] : [barberRoom(principal.barberId)]),
    ];
  }

  // A device gets exactly one room, and never `shop`. That is what stops a paired
  // tablet on the counter from receiving phone numbers.
  return [principal.deviceType === 'KIOSK' ? SOCKET_ROOM.kiosk : SOCKET_ROOM.display];
}
