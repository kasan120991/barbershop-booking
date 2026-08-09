/**
 * The kiosk: a paired device, a live board, and a way to join the line.
 *
 * **This client must never send credentials.** Not `withCredentials` on the socket, not
 * `credentials: 'include'` on fetch. The server resolves a session cookie before a
 * device token on both transports — deliberately, so a signed-in barber using the shop
 * tablet is themselves — and cookies ignore ports. A browser used for both apps on one
 * host would therefore carry the staff session into the kiosk's own requests, and the
 * socket would join `shop` and receive full phone numbers on a screen facing the room.
 * Nothing on the server can tell the two cases apart. This is the only thing that keeps
 * them apart, which is why `realtime.test.ts` pins the precedence it depends on.
 *
 * The token lives in `localStorage` because the tablet is paired once and left running
 * for months; it has to survive a reload and a power cut. That is the documented trade
 * for the device model — narrow scope, no expiry, revocable by an admin.
 */

import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  PublicQueueBoardDto,
  ServerToClientEvents,
  ShopSettingsDto,
  BarberPublicDto,
  ServiceDto,
} from '@francis/shared';

type KioskSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const TOKEN_KEY = 'fc_device_token';

/** The socket lives at the API origin, not under its `/api` path. */
function socketOrigin(apiBase: string): string {
  try {
    return new URL(apiBase, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

export function useKiosk() {
  const config = useRuntimeConfig();
  const api = useApi();

  const token = useState<string | null>('kiosk:token', () => null);
  const board = useState<PublicQueueBoardDto | null>('kiosk:board', () => null);
  const connected = useState<boolean>('kiosk:connected', () => false);
  const services = useState<ServiceDto[]>('kiosk:services', () => []);
  const barbers = useState<BarberPublicDto[]>('kiosk:barbers', () => []);
  const settings = useState<ShopSettingsDto | null>('kiosk:settings', () => null);

  let socket: KioskSocket | null = null;

  const paired = computed(() => token.value !== null);
  const timezone = computed(() => settings.value?.timezone ?? 'America/New_York');
  const walkInsOpen = computed(() => board.value?.queueEnabled ?? true);

  // --- Identity -----------------------------------------------------------------

  function loadToken(): void {
    token.value = localStorage.getItem(TOKEN_KEY);
  }

  function storeToken(value: string): void {
    localStorage.setItem(TOKEN_KEY, value);
    token.value = value;
  }

  /**
   * Forgets the device.
   *
   * Called when the API answers 401, which for a kiosk means one thing: an admin
   * revoked it. That is the opposite of the staff app, where a 401 means a session
   * expired and the answer is to sign in again — here there is nobody to sign in, so
   * the screen goes back to asking for a code.
   */
  function forgetToken(): void {
    localStorage.removeItem(TOKEN_KEY);
    token.value = null;
    board.value = null;
    socket?.disconnect();
    socket = null;
    connected.value = false;
  }

  /** Trades a pairing code for the token, once. Throws so the screen can show why. */
  async function pair(pairingCode: string): Promise<void> {
    const response = await api<{ deviceToken: string }>('/devices/pair', {
      method: 'POST',
      body: { pairingCode },
    });
    storeToken(response.deviceToken);
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

  /** The menu and roster. Public endpoints — the token is neither needed nor sent. */
  async function loadOptions(): Promise<void> {
    const [serviceRes, barberRes, settingsRes] = await Promise.all([
      api<{ services: ServiceDto[] }>('/services'),
      api<{ barbers: BarberPublicDto[] }>('/barbers'),
      api<{ settings: ShopSettingsDto }>('/shop-settings'),
    ]);
    services.value = serviceRes.services;
    barbers.value = barberRes.barbers;
    settings.value = settingsRes.settings;
  }

  /**
   * The walk-in menu — `bookableWalkIn`, not `bookableOnline`.
   *
   * These are different questions and the kiosk answers the walk-in one: the shop can
   * refuse to promise a two-hour colour to a queue that has to keep moving while still
   * selling it by appointment. The staff walk-in dialog filters the same way.
   */
  const walkInServices = computed(() =>
    services.value
      .filter((service) => service.isActive && service.bookableWalkIn)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  );

  /** Likewise `acceptsWalkIns`, not `acceptsOnline`. */
  function eligibleBarbers(serviceIds: string[]) {
    return barbers.value
      .filter((barber) => barber.acceptsWalkIns)
      .filter((barber) => serviceIds.every((id) => barber.serviceIds.includes(id)))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
  }

  // --- Joining -------------------------------------------------------------------

  async function join(input: {
    phone: string;
    firstName: string;
    lastName?: string | null;
    barberId: string | null;
    serviceIds: string[];
  }): Promise<{ entryId: string; board: PublicQueueBoardDto }> {
    const response = await api<{ entryId: string; board: PublicQueueBoardDto }>('/queue', {
      method: 'POST',
      headers: deviceHeaders(),
      body: input,
    });
    board.value = response.board;
    return response;
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

      // The only event a kiosk is entitled to. The server sends it on connect as well
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
    paired,
    board,
    connected,
    services,
    barbers,
    settings,
    timezone,
    walkInsOpen,
    walkInServices,
    eligibleBarbers,
    loadToken,
    forgetToken,
    pair,
    loadBoard,
    loadOptions,
    join,
    connect,
  };
}
