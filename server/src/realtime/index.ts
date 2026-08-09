/**
 * The realtime layer.
 *
 * Broadcast-only, and the type system enforces it: `ClientToServerEvents` is empty, so
 * there is no `socket.on(...)` here for anything a client could send. Every mutation
 * arrives over authenticated REST, where it is validated, authorised and audited, and
 * only the result is pushed out. There is deliberately no second write path.
 *
 * The emit itself lives in `broadcast.ts` so that this file — which needs to read the
 * queue board on connect — and the queue service — which needs to broadcast — do not
 * import each other.
 */

import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';

import { allowedOrigins } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { toPublicQueueBoardDto, toQueueBoardDto } from '../mappers/queue.js';
import { getQueueBoard } from '../services/queue.js';
import { registerRealtime } from './broadcast.js';
import { resolveSocketPrincipal } from './handshake.js';
import { roomsFor } from './rooms.js';
import type { RealtimeServer, RealtimeSocket } from './types.js';

export { broadcastQueueBoard, closeRealtime } from './broadcast.js';
export type { RealtimeServer } from './types.js';

export function createRealtime(httpServer: HttpServer): RealtimeServer {
  const server: RealtimeServer = new Server(httpServer, {
    // The same allowlist the HTTP layer uses; spread because it is readonly.
    cors: { origin: [...allowedOrigins], credentials: true },
  });

  server.use((socket, next) => {
    void resolveSocketPrincipal(socket)
      .then((principal) => {
        if (!principal) {
          // Rejected rather than held open. An unidentified socket has no room to join
          // and nothing it is entitled to receive, so there is nothing to keep alive.
          next(new Error('unauthorized'));
          return;
        }

        socket.data.principal = principal;
        socket.data.rooms = roomsFor(principal);
        next();
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Socket handshake failed');
        next(new Error('unauthorized'));
      });
  });

  server.on('connection', (socket) => {
    const { principal, rooms } = socket.data;
    void socket.join(rooms);

    socket.emit('connection:ready', {
      serverTime: new Date().toISOString(),
      // Sent back rather than assumed: the client renders from the rooms it was
      // actually placed in, not from what it believes its own role to be.
      rooms,
    });

    /**
     * Current state, immediately.
     *
     * Without it, a client that reconnects after a dropped link keeps whatever it had
     * when the link died until somebody happens to mutate the queue — which on a quiet
     * afternoon could be an hour. The board is small and the connections are few.
     */
    void sendCurrentBoard(socket).catch((error: unknown) => {
      logger.error({ err: error }, 'Failed to send the queue board on connect');
    });

    logger.debug(
      {
        kind: principal.kind,
        id: principal.kind === 'user' ? principal.userId : principal.deviceId,
        rooms,
      },
      'Socket connected',
    );
  });

  registerRealtime(server);
  return server;
}

/** One board in, two shapes out — whichever this socket is entitled to. */
async function sendCurrentBoard(socket: RealtimeSocket): Promise<void> {
  const board = await getQueueBoard();

  if (socket.data.principal.kind === 'user') {
    socket.emit('queue:updated', toQueueBoardDto(board));
    return;
  }
  socket.emit('queue:public', toPublicQueueBoardDto(board));
}
