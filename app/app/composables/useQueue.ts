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
