/**
 * The kiosk's own half: the walk-in menu and joining the line.
 *
 * Everything about being a paired screen — the token, the board, the socket that must
 * never carry credentials — lives in `useDeviceScreen` and is shared with the wall
 * display. This file is only the part a wall display has no business doing.
 */

import {
  walkInOpeningLabel,
  type BarberPublicDto,
  type PublicQueueBoardDto,
  type ServiceDto,
  type WalkInQuoteDto,
} from '@francis/shared';

export function useKiosk() {
  const api = useApi();
  const screen = useDeviceScreen();

  const services = useState<ServiceDto[]>('kiosk:services', () => []);
  const barbers = useState<BarberPublicDto[]>('kiosk:barbers', () => []);
  const quote = useState<WalkInQuoteDto | null>('kiosk:quote', () => null);

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

  // --- What each barber would cost them in waiting ----------------------------

  /**
   * Guards against the slower of two answers landing last.
   *
   * A customer taps Cut, then Beard, and two requests are in flight for two different
   * baskets. Without this the first can arrive second and put a thirty-minute figure
   * under a forty-five-minute basket — a wrong number beside a barber's name, which is
   * worse than no number at all.
   */
  let asked = 0;

  /**
   * The quote for a basket. A courtesy, so nothing here can stop somebody joining.
   *
   * The board's own headline is measured against the shortest thing on the walk-in menu,
   * which is the right answer at the door and the wrong one here: by this point they have
   * chosen, and an hour-long cut does not fit where a line-up does.
   */
  async function loadQuote(serviceIds: string[]): Promise<void> {
    if (serviceIds.length === 0) {
      clearQuote();
      return;
    }

    const mine = (asked += 1);
    try {
      const response = await api<{ quote: WalkInQuoteDto }>('/queue/quote', {
        query: { serviceIds: serviceIds.join(',') },
        headers: screen.deviceHeaders(),
      });
      if (mine !== asked) return;
      quote.value = response.quote;
    } catch (error) {
      if (mine !== asked) return;
      // A 401 on a screen means revoked, not expired — the same rule `loadBoard` follows.
      if (toApiFailure(error).status === 401) {
        screen.forgetToken();
        return;
      }
      // The menu changed under them, or the shop is unreachable. The Join button will say
      // so properly; these lines simply go quiet rather than state something untrue.
      quote.value = null;
    }
  }

  function clearQuote(): void {
    asked += 1;
    quote.value = null;
  }

  /**
   * True only when the answer on hand was computed for exactly this basket.
   *
   * The sequence number above orders our own requests; this catches everything else — a
   * refetch triggered by the board moving while a thumb is mid-tap, a tablet resumed from
   * sleep. It is why the server echoes back the services it answered about.
   */
  function quoteMatches(serviceIds: string[]): boolean {
    const held = quote.value;
    if (held === null || held.serviceIds.length !== serviceIds.length) return false;
    const asked = [...serviceIds].sort();
    return [...held.serviceIds].sort().every((id, index) => id === asked[index]);
  }

  /**
   * Minutes until an opening, counted against the ticking clock rather than read off the
   * answer — the same reasoning as `walkUpMinutes`, and for the same failure: `waitMinutes`
   * was measured when the quote was made, and somebody reads this screen for a minute or
   * two while deciding.
   *
   * Three outcomes, and they must stay three. `undefined` is "no answer for this person",
   * `null` is "an answer, and it is not today", a number is a wait. Collapsing the first
   * two labels a barber who is merely missing from the payload as fully booked.
   */
  function openingMinutes(
    opening: { availableAt: string | null; waitMinutes: number | null } | null | undefined,
  ): number | null | undefined {
    if (opening === null || opening === undefined) return undefined;
    if (opening.availableAt === null) return null;
    if (screen.now.value === null) return opening.waitMinutes;
    return Math.max(0, Math.round((new Date(opening.availableAt).getTime() - screen.now.value) / 60_000));
  }

  const barberWaits = computed(
    () =>
      new Map(
        (quote.value?.barbers ?? []).map((row) => [row.barberId, openingMinutes(row)] as const),
      ),
  );

  const anyoneWait = computed(() => openingMinutes(quote.value?.soonest));

  /**
   * A third vocabulary for a third audience, and it names the quantity out loud.
   *
   * `waitLabel` talks to somebody already in the line and `nextOpeningLabel` to somebody
   * who has not picked anything. This one talks to somebody comparing people, and the
   * claim it makes is conditional: *if* you pick him, you sit down in this long.
   *
   * Which is why it says "25 mins wait" rather than the front door's "about 25 mins".
   * Sitting under a barber's name with no heading of its own, a bare duration reads just
   * as easily as how long *he* takes — the one misreading here that would cost the shop
   * something, since it would push people towards whoever looked quickest at cutting.
   *
   * The three states themselves are `walkInOpeningLabel` in `shared`, because the staff
   * dialog asks the same question about the same person from the other side of the
   * counter and the two must not drift apart. Only the suffix is this screen's.
   */
  const pickLabel = (minutes: number | null | undefined): string =>
    walkInOpeningLabel(minutes, { suffix: 'wait' });

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
    quote,
    loadQuote,
    clearQuote,
    quoteMatches,
    barberWaits,
    anyoneWait,
    pickLabel,
  };
}
