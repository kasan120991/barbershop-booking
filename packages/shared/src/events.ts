/**
 * The Socket.IO contract.
 *
 * This map is imported by the server emitters AND by both Nuxt apps, so renaming
 * an event or changing a payload breaks the build everywhere at once instead of
 * failing silently at runtime in the shop.
 *
 * The full event set lands with the realtime phase; this is the wiring plus the
 * connection handshake.
 */

import { z } from 'zod';

/** Fixed rooms. `shop` is staff-only; `kiosk` and `display` receive redacted payloads only. */
export const SOCKET_ROOM = {
  /** Every authenticated staff member — full payloads. */
  shop: 'shop',
  /** In-shop tablet: join queue, read the board. Redacted payloads. */
  kiosk: 'kiosk',
  /** Wall-mounted read-only board. Redacted payloads. */
  display: 'display',
} as const;

export type SocketRoom = (typeof SOCKET_ROOM)[keyof typeof SOCKET_ROOM];

/** Per-barber room, for events only that barber should receive. */
export function barberRoom(barberId: string): string {
  return `barber:${barberId}`;
}

export const connectionReadySchema = z.object({
  serverTime: z.iso.datetime(),
  /** Which rooms this connection was actually placed in — the client should not assume. */
  rooms: z.array(z.string()),
});

export type ConnectionReady = z.infer<typeof connectionReadySchema>;

/** Events the server broadcasts. Add new events here first, then emit them. */
export interface ServerToClientEvents {
  'connection:ready': (payload: ConnectionReady) => void;
}

/**
 * Intentionally empty, and it must stay that way.
 *
 * Sockets are broadcast-only: every mutation goes over authenticated REST and the
 * server emits afterward. Accepting a write here would mean re-implementing auth,
 * validation, and audit logging in a second place — which will drift from the first.
 */
export type ClientToServerEvents = Record<never, never>;
