/**
 * The emit side, kept deliberately separate from the server that creates it.
 *
 * `services/queue.ts` has to be able to broadcast, and `realtime/index.ts` has to be
 * able to read the queue board when a client connects. Putting both in one file makes
 * those two modules import each other — a runtime cycle that happens to work today and
 * bites the first time bundling reorders it.
 *
 * So the socket handle lives here, in a module that imports nothing from the services
 * layer at runtime. `realtime/index.ts` registers the server it built; `queue.ts` calls
 * `broadcastQueueBoard`. Neither knows about the other.
 */

import { SOCKET_ROOM } from '@francis/shared';

import { logger } from '../lib/logger.js';
import { toPublicQueueBoardDto, toQueueBoardDto } from '../mappers/queue.js';
// Type-only, so it is erased at compile time and creates no runtime edge back to the
// service that calls into this file.
import type { QueueBoard } from '../services/queue.js';
import type { RealtimeServer } from './types.js';

/**
 * Null until the process builds a server — which is the normal state under test and in
 * any script that imports a service. That is why every function here is a no-op rather
 * than a throw: needing a socket server to run the booking logic would be backwards.
 */
let io: RealtimeServer | null = null;

export function registerRealtime(server: RealtimeServer): void {
  io = server;
}

/**
 * Pushes a recomputed board to everyone entitled to see it.
 *
 * One board in, two shapes out: `shop` gets the full one, `kiosk` and `display` get the
 * redacted one from the same mapper the HTTP device board uses. Those screens face the
 * room, and the split is enforced by the event map — there is no way to send the wrong
 * shape to the wrong room without a compile error.
 *
 * Never throws. A failed broadcast must not roll back a mutation that succeeded; the
 * slow poll running underneath the socket is what picks up the pieces.
 */
export function broadcastQueueBoard(board: QueueBoard): void {
  if (!io) return;

  try {
    io.to(SOCKET_ROOM.shop).emit('queue:updated', toQueueBoardDto(board));
    io.to([SOCKET_ROOM.kiosk, SOCKET_ROOM.display]).emit(
      'queue:public',
      toPublicQueueBoardDto(board),
    );
  } catch (error) {
    logger.error({ err: error }, 'Queue broadcast failed');
  }
}

/**
 * Closes every connection.
 *
 * Must run before `httpServer.close()`. An open websocket is an open connection, and
 * the HTTP server waits for it rather than finishing — which would turn every deploy
 * into a ten-second wait for the shutdown backstop to fire.
 */
export async function closeRealtime(): Promise<void> {
  if (!io) return;

  const server = io;
  io = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
