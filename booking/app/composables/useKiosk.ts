/**
 * The kiosk's own half: the walk-in menu and joining the line.
 *
 * Everything about being a paired screen — the token, the board, the socket that must
 * never carry credentials — lives in `useDeviceScreen` and is shared with the wall
 * display. This file is only the part a wall display has no business doing.
 */

import type {
  BarberPublicDto,
  PublicQueueBoardDto,
  ServiceDto,
} from '@francis/shared';

export function useKiosk() {
  const api = useApi();
  const screen = useDeviceScreen();

  const services = useState<ServiceDto[]>('kiosk:services', () => []);
  const barbers = useState<BarberPublicDto[]>('kiosk:barbers', () => []);

  /** The menu and roster. Public endpoints — the token is neither needed nor sent. */
  async function loadOptions(): Promise<void> {
    const [serviceRes, barberRes] = await Promise.all([
      api<{ services: ServiceDto[] }>('/services'),
      api<{ barbers: BarberPublicDto[] }>('/barbers'),
    ]);
    services.value = serviceRes.services;
    barbers.value = barberRes.barbers;
    await screen.loadSettings();
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

  async function join(input: {
    phone: string;
    firstName: string;
    lastName?: string | null;
    barberId: string | null;
    serviceIds: string[];
  }): Promise<{ entryId: string; board: PublicQueueBoardDto }> {
    const response = await api<{ entryId: string; board: PublicQueueBoardDto }>('/queue', {
      method: 'POST',
      headers: screen.deviceHeaders(),
      body: input,
    });
    screen.board.value = response.board;
    return response;
  }

  return {
    // The shared screen, spread so callers keep the flat shape they had.
    ...screen,
    services,
    barbers,
    walkInServices,
    eligibleBarbers,
    loadOptions,
    join,
  };
}
