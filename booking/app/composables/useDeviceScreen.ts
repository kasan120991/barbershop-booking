/**
 * A paired in-shop screen: the kiosk by the door and the board on the wall.
 *
 * Everything both screens share lives here — the device identity, the redacted board,
 * and the socket. `useKiosk` builds the joining half on top; the display uses this and
 * nothing else.
 *
 * **This client must never send credentials.** Not `withCredentials` on the socket, not
 * `credentials: 'include'` on fetch. The server resolves a session cookie before a
 * device token on both transports — deliberately, so a signed-in barber using the shop
 * tablet is themselves — and cookies ignore ports. A browser used for both apps on one
 * host would therefore carry the staff session into a screen's own requests, and the
 * socket would join `shop` and put full phone numbers on something the whole room can
 * see. Nothing on the server can tell the two cases apart. This file is the only thing
 * that keeps them apart, and it is shared rather than copied for exactly that reason:
 * a second implementation that quietly picked up `withCredentials` is the failure.
 * `realtime.test.ts` pins the precedence it depends on.
 *
 * The token lives in `localStorage` because a screen is paired once and left running for
 * months; it has to survive a reload and a power cut. That is the documented trade for
 * the device model — narrow scope, no expiry, revocable by an admin.
 */

import { formatDuration } from '@francis/shared';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  DeviceType,
  PublicQueueBoardDto,
  PublicQueueEntryDto,
  ServerToClientEvents,
  ShopSettingsDto,
} from '@francis/shared';

type DeviceSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const TOKEN_KEY = 'fc_device_token';
/**
 * Stored beside the token because nothing else can tell the client what it is.
 *
 * The pairing response carries the type once and no later request returns it — not even
 * `GET /queue/board` — so without keeping it, a reload leaves a screen unable to say
 * whether it is a kiosk or a wall board. It was discarded before this, and the result
 * was a display-paired tablet rendering the whole join flow and only failing with a 403
 * after somebody had typed their phone number in.
 */
const TYPE_KEY = 'fc_device_type';

/** The socket lives at the API origin, not under its `/api` path. */
function socketOrigin(apiBase: string): string {
  try {
    return new URL(apiBase, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

export function useDeviceScreen() {
  const config = useRuntimeConfig();
  const api = useApi();

  const token = useState<string | null>('device:token', () => null);
  const deviceType = useState<DeviceType | null>('device:type', () => null);
  const board = useState<PublicQueueBoardDto | null>('device:board', () => null);
  const connected = useState<boolean>('device:connected', () => false);
  const settings = useState<ShopSettingsDto | null>('device:settings', () => null);

  let socket: DeviceSocket | null = null;

  const paired = computed(() => token.value !== null);
  const timezone = computed(() => settings.value?.timezone ?? 'America/New_York');
  const walkInsOpen = computed(() => board.value?.queueEnabled ?? true);

  // --- Identity -----------------------------------------------------------------

  function loadToken(): void {
    token.value = localStorage.getItem(TOKEN_KEY);
    const storedType = localStorage.getItem(TYPE_KEY);
    deviceType.value = storedType === 'KIOSK' || storedType === 'DISPLAY' ? storedType : null;
  }

  function storeToken(value: string, type: DeviceType): void {
    localStorage.setItem(TOKEN_KEY, value);
    localStorage.setItem(TYPE_KEY, type);
    token.value = value;
    deviceType.value = type;
  }

  /**
   * Forgets the device.
   *
   * Called when the API answers 401, which on a screen means one thing: an admin revoked
   * it. That is the opposite of the staff app, where a 401 means a session expired and
   * the answer is to sign in again — here there is nobody to sign in, so the screen goes
   * back to asking for a code. The board is dropped with it, because a revoked screen
   * must not sit there showing names.
   */
  function forgetToken(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TYPE_KEY);
    token.value = null;
    deviceType.value = null;
    board.value = null;
    socket?.disconnect();
    socket = null;
    connected.value = false;
  }

  /** Trades a pairing code for a token, once. Throws so the screen can show why. */
  async function pair(pairingCode: string): Promise<void> {
    const response = await api<{ deviceToken: string; type: DeviceType }>('/devices/pair', {
      method: 'POST',
      body: { pairingCode },
    });
    storeToken(response.deviceToken, response.type);
  }

  // --- Data ---------------------------------------------------------------------

  /** Every device request carries the token as a header; nothing carries a cookie. */
  function deviceHeaders(): Record<string, string> {
    return token.value === null ? {} : { 'x-device-token': token.value };
  }

  async function loadBoard(): Promise<void> {
    if (token.value === null) return;
    try {
      board.value = (
        await api<{ board: PublicQueueBoardDto }>('/queue/board', { headers: deviceHeaders() })
      ).board;
    } catch (error) {
      if (toApiFailure(error).status === 401) forgetToken();
    }
  }

  /** Shop settings, for the timezone. A public endpoint — the token is not sent. */
  async function loadSettings(): Promise<void> {
    settings.value = (await api<{ settings: ShopSettingsDto }>('/shop-settings')).settings;
  }

  // --- Reading the board ----------------------------------------------------------

  const called = computed(
    () => board.value?.entries.filter((entry) => entry.status === 'CALLED') ?? [],
  );

  const waiting = computed(
    () => board.value?.entries.filter((entry) => entry.status === 'WAITING') ?? [],
  );

  const chairs = computed(() => board.value?.chairs ?? []);

  /** The longest anybody currently waiting has been quoted. */
  const longestWait = computed(() =>
    waiting.value.reduce((max, entry) => Math.max(max, entry.estimatedWaitMinutes ?? 0), 0),
  );

  function waitLabel(minutes: number | null): string {
    if (minutes === null) return 'Ask at the desk';
    if (minutes < 1) return 'You are up';
    return `about ${formatDuration(minutes)}`;
  }

  /**
   * The next opening for somebody who has not joined — the kiosk's headline.
   *
   * Not derivable here, which is why the server sends it: `chairs[].freeFrom` is measured
   * before the waiting line is allocated and would read "free now" with four people
   * sitting in the room, and the entries' own waits belong to people already in the line.
   */
  const walkUp = computed(() => board.value?.walkUp ?? null);

  /**
   * Deliberately different words from `waitLabel`.
   *
   * That one talks to somebody who has joined and has a quote of their own; this one talks
   * to somebody standing at the screen who has not picked a service yet, so the honest
   * claim is about the shop's next opening rather than about their wait. The screen says
   * "Next opening" above it for the same reason.
   */
  const nextOpeningLabel = computed(() => {
    const minutes = walkUp.value?.waitMinutes ?? null;
    if (minutes === null) return 'Ask at the desk';
    if (minutes < 1) return 'No wait';
    return `about ${formatDuration(minutes)}`;
  });

  /** "4 people ahead of you", or null at zero rather than "0 people ahead of you". */
  const aheadLabel = computed(() => {
    const count = waiting.value.length;
    if (count === 0) return null;
    return `${count} ${count === 1 ? 'person' : 'people'} ahead of you`;
  });

  /** Instants render in the SHOP's zone, on every screen in the system. */
  function clock(iso: string | null): string {
    if (iso === null) return '';
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone.value,
    }).format(new Date(iso));
  }

  // --- Realtime ------------------------------------------------------------------

  /** Opens the socket for as long as the calling component is mounted. */
  function connect(): void {
    const open = () => {
      if (token.value === null || socket) return;

      socket = io(socketOrigin(config.public.apiBase), {
        // The device token, and NOTHING else — see the note at the top of this file.
        auth: { deviceToken: token.value },
      });

      socket.on('connect', () => {
        connected.value = true;
      });
      socket.on('disconnect', () => {
        connected.value = false;
      });
      socket.on('connect_error', () => {
        connected.value = false;
      });

      // The only event a screen is entitled to. The server sends it on connect as well
      // as after every change, so a reconnect catches up without a reload.
      socket.on('queue:public', (payload: PublicQueueBoardDto) => {
        board.value = payload;
      });
    };

    onMounted(() => {
      loadToken();
      open();
      // Pairing happens after mount, so the socket waits for a token to exist.
      watch(token, (value) => {
        if (value === null) return;
        open();
      });
    });

    onUnmounted(() => {
      socket?.disconnect();
      socket = null;
      connected.value = false;
    });
  }

  return {
    token,
    deviceType,
    paired,
    board,
    connected,
    settings,
    timezone,
    walkInsOpen,
    called,
    waiting,
    chairs,
    longestWait,
    walkUp,
    waitLabel,
    nextOpeningLabel,
    aheadLabel,
    clock,
    deviceHeaders,
    loadToken,
    forgetToken,
    pair,
    loadBoard,
    loadSettings,
    connect,
  };
}

export type { PublicQueueEntryDto };
