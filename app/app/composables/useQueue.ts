/**
 * The live walk-in queue.
 *
 * Unusually for this app, mutations do **not** refetch. Every queue write already
 * returns the recomputed board, because moving one person renumbers everyone behind
 * them — the server has to run the estimator anyway, so a follow-up GET would be the
 * second time it did the same work, and there would be a moment in between where the
 * screen showed a board that no longer existed.
 *
 * Polling is the temporary half. Phase 7 replaces `poll()` with a socket subscription
 * to the `shop` room; nothing else in here or in the components has to change, because
 * both do the same thing — put a fresh `QueueBoardDto` in the same piece of state.
 */

import type {
  BarberStaffDto,
  JoinQueueRequest,
  QueueBoardDto,
  QueueEntryDto,
  ServiceDto,
  ShopSettingsDto,
  WalkInQuoteDto,
} from '@francis/shared';

export function useQueue() {
  const api = useApi();

  // `useState`, not `ref` — the page, the add dialog, the nav and the top bar all call
  // this, and separate copies would mean the badge and the board disagreeing.
  const board = useState<QueueBoardDto | null>('queue:board', () => null);
  const loading = useState<boolean>('queue:loading', () => false);
  const services = useState<ServiceDto[]>('queue:services', () => []);
  const barbers = useState<BarberStaffDto[]>('queue:barbers', () => []);
  const settings = useState<ShopSettingsDto | null>('queue:settings', () => null);
  const quote = useState<WalkInQuoteDto | null>('queue:quote', () => null);

  /**
   * `quiet` is for the poll. A failed background refresh must not raise a toast every
   * fifteen seconds, and must not blank a board that is still perfectly readable —
   * the connection banner in the shell already says the server is unreachable.
   */
  async function refresh(options: { quiet?: boolean } = {}): Promise<void> {
    if (!options.quiet) loading.value = true;
    try {
      board.value = (await api<{ board: QueueBoardDto }>('/queue')).board;
    } catch (error) {
      if (!options.quiet) throw error;
    } finally {
      if (!options.quiet) loading.value = false;
    }
  }

  /**
   * Loads the board if nothing has yet.
   *
   * For the `/queue` page's own SSR fetch. It must NOT be awaited from the layout: a
   * top-level `await` turns the shell into an async component and the `useTemplateRef`
   * further down its setup then runs with no instance context and throws, which takes
   * the whole page with it. The live counts render inside `<ClientOnly>` instead.
   */
  async function ensureLoaded(): Promise<void> {
    if (board.value === null) await refresh({ quiet: true });
  }

  /** Everything the add-walk-in form needs. Fetched once; the menu rarely changes. */
  async function loadOptions(): Promise<void> {
    const [serviceRes, barberRes, settingsRes] = await Promise.all([
      api<{ services: ServiceDto[] }>('/services'),
      api<{ barbers: BarberStaffDto[] }>('/barbers'),
      api<{ settings: ShopSettingsDto }>('/shop-settings'),
    ]);
    services.value = serviceRes.services;
    barbers.value = barberRes.barbers;
    settings.value = settingsRes.settings;
  }

  // --- What each barber would cost this customer in waiting --------------------

  /**
   * Guards against the slower of two answers landing last.
   *
   * The desk taps Cut, then Beard, and two requests are in flight for two different
   * baskets. Without this the first can arrive second and put a thirty-minute figure
   * beside a name under a forty-five-minute basket — a wrong number, which is worse than
   * no number at all.
   */
  let asked = 0;

  /**
   * The same question the kiosk asks, from behind the counter instead of in front of it.
   *
   * A courtesy: nothing here can stop somebody being added to the line, so a failure
   * leaves the labels blank rather than raising anything.
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
      });
      if (mine !== asked) return;
      quote.value = response.quote;
    } catch {
      if (mine !== asked) return;
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
   * refetch triggered by the line moving while somebody is mid-tap, a dialog reopened on
   * a stale answer. It is why the server echoes back the services it answered about.
   */
  function quoteMatches(serviceIds: string[]): boolean {
    const held = quote.value;
    if (held === null || held.serviceIds.length !== serviceIds.length) return false;
    const wanted = [...serviceIds].sort();
    return [...held.serviceIds].sort().every((id, index) => id === wanted[index]);
  }

  /**
   * Three outcomes, and they must stay three: `undefined` is "no answer for this barber",
   * `null` is "an answer, and it is not today", a number is a wait. Collapsing the first
   * two labels a barber who is merely missing from the payload as fully booked.
   *
   * Measured against the board's clock rather than the browser's, like every other figure
   * on this side — see the note at the top of `pages/queue.vue`.
   */
  function openingMinutes(
    opening: { availableAt: string | null; waitMinutes: number | null } | null | undefined,
  ): number | null | undefined {
    if (opening === null || opening === undefined) return undefined;
    if (opening.availableAt === null) return null;

    const asOf = board.value === null ? null : new Date(board.value.generatedAt).getTime();
    if (asOf === null) return opening.waitMinutes;
    return Math.max(0, Math.round((new Date(opening.availableAt).getTime() - asOf) / 60_000));
  }

  const barberWaits = computed(
    () =>
      new Map(
        (quote.value?.barbers ?? []).map((row) => [row.barberId, openingMinutes(row)] as const),
      ),
  );

  const anyoneWait = computed(() => openingMinutes(quote.value?.soonest));

  async function send<T extends Record<string, unknown>>(
    path: string,
    method: 'POST' | 'PATCH',
    body: T,
  ): Promise<void> {
    const response = await api<{ board: QueueBoardDto }>(path, { method, body });
    board.value = response.board;
  }

  const join = (input: JoinQueueRequest) => send('/queue', 'POST', { ...input });
  const callNext = (barberId: string) => send('/queue/call-next', 'POST', { barberId });
  const setStatus = (entryId: string, status: string) =>
    send(`/queue/${entryId}/status`, 'PATCH', { status });
  const setPriority = (entryId: string, priority: number) =>
    send(`/queue/${entryId}/priority`, 'PATCH', { priority });
  const setBarber = (entryId: string, barberId: string | null) =>
    send(`/queue/${entryId}/barber`, 'PATCH', { barberId });

  /**
   * Calls one specific person rather than whoever is next.
   *
   * Someone who did not name a barber has no barber attached — the chair shown against
   * them is the estimator's projection, not a claim — so calling them out of order has
   * to attach them first, or seating them would be refused for having no chair.
   */
  async function callSpecific(entry: QueueEntryDto): Promise<void> {
    if (entry.requestedBarberId === null) {
      if (entry.assignedBarberId === null) {
        throw new Error('Pick a barber for this walk-in first.');
      }
      await setBarber(entry.id, entry.assignedBarberId);
    }
    await setStatus(entry.id, 'CALLED');
  }

  /** Waiting only — someone called or seated is out of the line, not at the front of it. */
  const waitingCount = computed(
    () => board.value?.entries.filter((entry) => entry.status === 'WAITING').length ?? 0,
  );

  /**
   * Keeps the board fresh for as long as the calling component is mounted.
   *
   * Skips while the tab is hidden and catches up the moment it is shown again: the
   * shop tablet spends most of the day on this screen, and a poll that runs in a
   * background tab is load nobody is looking at.
   */
  function poll(intervalMs: number): void {
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = () => {
      if (document.visibilityState === 'visible') void refresh({ quiet: true });
    };

    onMounted(() => {
      void refresh({ quiet: true });
      timer = setInterval(tick, intervalMs);
      document.addEventListener('visibilitychange', tick);
    });

    onUnmounted(() => {
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    });
  }

  return {
    board,
    loading,
    services,
    barbers,
    settings,
    quote,
    loadQuote,
    clearQuote,
    quoteMatches,
    barberWaits,
    anyoneWait,
    waitingCount,
    refresh,
    ensureLoaded,
    loadOptions,
    poll,
    join,
    callNext,
    callSpecific,
    setStatus,
    setPriority,
    setBarber,
  };
}
