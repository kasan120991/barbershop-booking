/**
 * The socket connection, owned by the shell.
 *
 * One connection for the whole app, opened once in `layouts/default.vue` — not per
 * page, and not per component that happens to want the queue. The board it delivers
 * goes into the same `useState` slot that `refresh()` and every mutation already write,
 * so nothing that renders the queue knows or cares where a given board came from.
 *
 * This is receive-only. The server's `ClientToServerEvents` is empty by design, so
 * there is nothing to send: every mutation goes over authenticated REST through
 * `useApi`, and the socket only ever carries the result back.
 *
 * A slow poll still runs underneath it. Socket.IO reconnects on its own, but the
 * failure that actually costs the shop is a socket that believes it is connected and
 * has quietly stopped receiving — a frozen board reads exactly like a quiet morning.
 */

import { io, type Socket } from 'socket.io-client';
import type {
  AppointmentChanged,
  ClientToServerEvents,
  ConnectionReady,
  QueueBoardDto,
  ServerToClientEvents,
} from '@francis/shared';

type QueueSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * `apiBase` is `http://host:4000/api` — the socket lives at the origin, not under the
 * API path. Derived rather than configured separately so there is one URL to get wrong
 * in production instead of two that can disagree.
 */
function socketOrigin(apiBase: string): string {
  try {
    return new URL(apiBase, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

export function useRealtime() {
  const config = useRuntimeConfig();
  const queue = useQueue();
  const book = useAppointments();

  const connected = useState<boolean>('realtime:connected', () => false);
  const rooms = useState<string[]>('realtime:rooms', () => []);

  let socket: QueueSocket | null = null;

  /** Opens the connection for as long as the calling component is mounted. */
  function connect(): void {
    onMounted(() => {
      socket = io(socketOrigin(config.public.apiBase), {
        // Sends the session cookie, which is what the handshake authenticates on. The
        // server rejects a socket it cannot identify, so there is no anonymous mode.
        withCredentials: true,
      });

      socket.on('connect', () => {
        connected.value = true;
      });

      socket.on('disconnect', () => {
        connected.value = false;
      });

      /**
       * A rejected handshake is not a reason to sign anyone out.
       *
       * It happens on a server restart before the session is re-read, and treating it
       * as "signed out" would bounce someone to the login page mid-cut. The REST layer
       * is the authority on the session; this just keeps retrying.
       */
      socket.on('connect_error', () => {
        connected.value = false;
      });

      socket.on('connection:ready', (payload: ConnectionReady) => {
        rooms.value = payload.rooms;
      });

      // The server sends it on connect as well as after every mutation, so a reconnect
      // catches up without a reload.
      socket.on('queue:updated', (board: QueueBoardDto) => {
        queue.board.value = board;
      });

      /**
       * Somebody else moved an appointment — another admin at the desk, a client online,
       * or the phone.
       *
       * A signal rather than a board, and the difference is the point: the queue is one
       * thing every staff screen shows identically, while three pages read appointments
       * over three different days. So this only records what changed, and the pages decide
       * whether it is theirs. The shell must not know what a calendar is.
       */
      socket.on('appointment:changed', (change: AppointmentChanged) => {
        book.lastChange.value = change;
      });
    });

    onUnmounted(() => {
      socket?.disconnect();
      socket = null;
      connected.value = false;
      rooms.value = [];
      // Cleared so a remount cannot re-fire a page's watcher on a change from the last
      // session, refetching a range for something that happened before the reload.
      book.lastChange.value = null;
    });
  }

  return { connected, rooms, connect };
}
