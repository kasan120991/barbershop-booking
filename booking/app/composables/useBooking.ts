/**
 * The booking flow.
 *
 * Holds the five-step selection and does the one genuinely awkward thing on this site:
 * "any barber".
 *
 * The API has no notion of an unassigned appointment — `createAppointment` needs a
 * barber, because the double-booking lock is per barber per day and there is nothing to
 * lock without one. That is correct; a slot is only real against a specific chair. So
 * "any barber" is resolved *here*, by asking every eligible barber for their
 * availability and merging the answers. Picking 11:30 then means picking whoever can
 * actually do 11:30, and the confirmation names them, because "we'll see who's around"
 * is not a thing to tell somebody who is about to turn up.
 */

import type {
  BarberPublicDto,
  ServiceDto,
  ShopSettingsDto,
  AvailabilityResponse,
} from '@francis/shared';

/** A bookable start, and every barber who can take it. */
export interface Slot {
  startAt: string;
  barberIds: string[];
}

export const STEPS = ['Service', 'Barber', 'Time', 'Details', 'Confirm'] as const;
export type StepIndex = 1 | 2 | 3 | 4 | 5;

export function useBooking() {
  const api = useApi();

  const services = useState<ServiceDto[]>('booking:services', () => []);
  const barbers = useState<BarberPublicDto[]>('booking:barbers', () => []);
  const settings = useState<ShopSettingsDto | null>('booking:settings', () => null);
  const loaded = useState<boolean>('booking:loaded', () => false);

  const step = useState<StepIndex>('booking:step', () => 1);
  const serviceId = useState<string | null>('booking:service', () => null);
  /** Null means "any barber" — resolved when a slot is chosen, never sent as null. */
  const barberId = useState<string | null>('booking:barber', () => null);
  const anyBarber = useState<boolean>('booking:any', () => false);
  const date = useState<string>('booking:date', () => '');
  const slot = useState<Slot | null>('booking:slot', () => null);

  const details = useState('booking:details', () => ({
    firstName: '',
    lastName: '',
    phone: '',
  }));

  const slots = useState<Slot[]>('booking:slots', () => []);
  const slotsLoading = useState<boolean>('booking:slots-loading', () => false);
  /** The engine's own explanation for an empty day — closed, booked out, too far ahead. */
  const emptyReason = useState<string | null>('booking:empty-reason', () => null);

  // --- Loading -----------------------------------------------------------------

  async function load(): Promise<void> {
    if (loaded.value) return;

    const [serviceRes, barberRes, settingsRes] = await Promise.all([
      api<{ services: ServiceDto[] }>('/services'),
      api<{ barbers: BarberPublicDto[] }>('/barbers'),
      api<{ settings: ShopSettingsDto }>('/shop-settings'),
    ]);

    services.value = serviceRes.services;
    barbers.value = barberRes.barbers;
    settings.value = settingsRes.settings;
    loaded.value = true;

    if (!date.value) date.value = todayInShop();
  }

  const timezone = computed(() => settings.value?.timezone ?? 'America/New_York');

  /** Today as the SHOP reckons it, which is not necessarily today where the visitor is. */
  function todayInShop(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone.value,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  // --- Derived -----------------------------------------------------------------

  /**
   * The menu as the public may book it. `bookableOnline` is filtered here rather than by
   * the API, because the same endpoint feeds the kiosk, which needs the walk-in-only
   * rows. The server refuses these at write time regardless — this list is a courtesy,
   * not the boundary.
   */
  const bookableServices = computed(() =>
    services.value
      .filter((service) => service.isActive && service.bookableOnline)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  );

  const service = computed(
    () => bookableServices.value.find((row) => row.id === serviceId.value) ?? null,
  );

  /** Barbers who take online bookings AND can perform what was chosen. */
  const eligibleBarbers = computed(() => {
    const chosen = serviceId.value;
    return barbers.value
      .filter((barber) => barber.acceptsOnline)
      .filter((barber) => chosen === null || barber.serviceIds.includes(chosen))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
  });

  /** Who the client will actually see: their pick, or whoever the slot resolved to. */
  const resolvedBarber = computed(() => {
    const id = barberId.value ?? slot.value?.barberIds[0] ?? null;
    return id === null ? null : (barbers.value.find((row) => row.id === id) ?? null);
  });

  const totalCents = computed(() => service.value?.priceCents ?? 0);
  const totalMinutes = computed(() => service.value?.durationMinutes ?? 0);

  // --- Availability -------------------------------------------------------------

  /**
   * Merges several barbers' availability into one list of times.
   *
   * Every request is the same public endpoint the staff calendar uses, so the times
   * offered already account for shop hours, that barber's shift, their time off,
   * existing appointments, the turnaround buffer and the live walk-in queue.
   */
  async function loadSlots(): Promise<void> {
    const chosenService = service.value;
    if (!chosenService || !date.value) return;

    const targets = barberId.value === null ? eligibleBarbers.value : eligibleBarbers.value.filter((b) => b.id === barberId.value);
    if (targets.length === 0) {
      slots.value = [];
      emptyReason.value = 'Nobody is taking online bookings for that just now.';
      return;
    }

    slotsLoading.value = true;
    slot.value = null;

    try {
      const responses = await Promise.all(
        targets.map((barber) =>
          api<AvailabilityResponse>('/availability', {
            query: { barberId: barber.id, date: date.value, serviceIds: chosenService.id },
          })
            .then((result) => ({ barberId: barber.id, result }))
            // One barber's day failing must not blank the others'.
            .catch(() => ({ barberId: barber.id, result: null })),
        ),
      );

      const byStart = new Map<string, string[]>();
      const reasons: string[] = [];

      for (const { barberId: id, result } of responses) {
        if (!result) continue;
        if (result.slots.length === 0 && result.reason) reasons.push(result.reason);
        for (const startAt of result.slots) {
          const existing = byStart.get(startAt);
          if (existing) existing.push(id);
          else byStart.set(startAt, [id]);
        }
      }

      slots.value = [...byStart.entries()]
        .map(([startAt, barberIds]) => ({ startAt, barberIds }))
        .sort((a, b) => a.startAt.localeCompare(b.startAt));

      // With one barber the engine's own words are exactly right; across several,
      // "Marcus is off" would be misleading, so only a shared reason is repeated.
      emptyReason.value =
        slots.value.length > 0
          ? null
          : reasons.length > 0 && reasons.every((reason) => reason === reasons[0])
            ? (reasons[0] ?? null)
            : 'Nothing free that day.';
    } finally {
      slotsLoading.value = false;
    }
  }

  // --- Navigation ---------------------------------------------------------------

  /** Which steps are answered — drives both the rail and whether Continue is offered. */
  const completed = computed<Record<StepIndex, boolean>>(() => ({
    1: service.value !== null,
    2: barberId.value !== null || anyBarber.value,
    3: slot.value !== null,
    4:
      details.value.firstName.trim().length > 0 && details.value.phone.trim().length > 0,
    5: false,
  }));

  /**
   * Which way the last move went, so the transition can slide the right way.
   *
   * A stepper that animates the same direction both ways feels like the page is
   * reloading rather than moving; matching the direction to the gesture is most of
   * what makes "back" feel like back.
   */
  const direction = useState<'forward' | 'back'>('booking:direction', () => 'forward');

  function goTo(next: StepIndex): void {
    // Backwards is always allowed; forwards only into a step whose predecessors are
    // answered, so the rail can never strand somebody on a screen with no context.
    if (next <= step.value) {
      direction.value = next < step.value ? 'back' : 'forward';
      step.value = next;
      return;
    }
    for (let i = 1 as StepIndex; i < next; i = (i + 1) as StepIndex) {
      if (!completed.value[i]) return;
    }
    direction.value = 'forward';
    step.value = next;
  }

  function reset(): void {
    step.value = 1;
    serviceId.value = null;
    barberId.value = null;
    anyBarber.value = false;
    slot.value = null;
    slots.value = [];
    date.value = todayInShop();
    details.value = { firstName: '', lastName: '', phone: '' };
  }

  return {
    // data
    services,
    barbers,
    settings,
    loaded,
    timezone,
    // selection
    step,
    direction,
    serviceId,
    barberId,
    anyBarber,
    date,
    slot,
    details,
    // derived
    bookableServices,
    service,
    eligibleBarbers,
    resolvedBarber,
    totalCents,
    totalMinutes,
    completed,
    // availability
    slots,
    slotsLoading,
    emptyReason,
    // actions
    load,
    loadSlots,
    goTo,
    reset,
    todayInShop,
  };
}
