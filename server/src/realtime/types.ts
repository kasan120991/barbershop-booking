/**
 * Socket types, in their own file so the emitter and the server can share them without
 * importing each other.
 */

import type { ClientToServerEvents, ServerToClientEvents } from '@francis/shared';
import type { Server, Socket } from 'socket.io';

import type { AuthPrincipal } from '../middleware/authenticate.js';

export interface SocketData {
  principal: AuthPrincipal;
  /** The rooms this connection was actually placed in, decided at handshake. */
  rooms: string[];
}

/** No client-to-server events by design — see `shared/src/events.ts`. */
type NoClientEvents = Record<never, never>;

export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  NoClientEvents,
  SocketData
>;

export type RealtimeSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  NoClientEvents,
  SocketData
>;
