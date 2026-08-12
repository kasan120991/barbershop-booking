/**
 * One barber's day, appointments and walk-ins in a single time-ordered list.
 *
 * A chair holds two kinds of work that live in two different tables — a booked
 * `Appointment` and a `QueueEntry` the estimator has pencilled in — and the barber
 * standing at that chair does not care which is which. This is where the two become one
 * list, and it is shared rather than copied because a second copy is how two screens in
 * the same shop start disagreeing about the same afternoon.
 *
 * **It does not fetch.** Both callers own their own `loadRange`, over the same
 * `useAppointments` state, and a composable that fetched as well would give one
 * `useState` slot two competing loaders. The queue half costs nothing either way: the
 * board is already in shared state, polled by the shell and pushed by the socket.
 */

import type { AppointmentDto, QueueEntryDto } from '@francis/shared';

/** One piece of work in a barber's day, whichever table it came from. */
export interface DayItem {
  key: string;
  startAt: string;
  endAt: string | null;
  clientName: string;
  services: string;
  durationMinutes: number;
  priceCents: number;
  source: string | null;
  notes: string | null;
  /** An appointment, or a walk-in the estimator has pencilled in. */
  projected: boolean;
  /** True only while the estimate can still move — a waiting walk-in, not a seated one. */
  moving: boolean;
  status: string;
  appointment: AppointmentDto | null;
}

/** The statuses a walk-in still occupies a barber's time in. */
const ACTIVE_WALK_IN = ['WAITING', 'CALLED', 'IN_CHAIR'];

function sourceLabel(source: string): string | null {
  if (source === 'KIOSK') return 'Kiosk';
  if (source === 'ONLINE') return 'Online';
  if (source === 'VOICE') return 'Phone';
  return null;
}

export function fromAppointment(appointment: AppointmentDto): DayItem {
  return {
    key: appointment.id,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    clientName: appointment.clientName,
    services: appointment.services.map((service) => service.name).join(' + '),
    durationMinutes: appointment.durationMinutes,
    priceCents: appointment.priceCentsTotal,
    source: sourceLabel(appointment.source),
    notes: appointment.notes,
    projected: false,
    moving: false,
    status: appointment.status,
    appointment,
  };
}

export function fromQueueEntry(entry: QueueEntryDto): DayItem {
  return {
    key: `queue:${entry.id}`,
    // Guarded by the filters below — an entry with no estimate is not placed.
    startAt: entry.estimatedReadyAt ?? '',
    endAt: null,
    clientName: entry.clientName,
    services: entry.services.map((service) => service.name).join(' + '),
    durationMinutes: entry.durationMinutes,
    priceCents: entry.priceCentsTotal,
    source: 'Walk-in',
    notes: entry.notes,
    projected: true,
    moving: entry.status === 'WAITING',
    status: entry.status,
    appointment: null,
  };
}

export function useDayLineup(input: {
  /** The chair this lineup belongs to. Null renders as an empty day, not the shop's. */
  barberId: Ref<string | null>;
  /** The shop-local `YYYY-MM-DD` being shown. */
  date: Ref<string>;
  /** Whether that date is today — walk-ins only exist on one. */
  isToday: Ref<boolean>;
}) {
  const book = useAppointments();
  const queue = useQueue();
  const shop = useShopClock();

  /** The day's appointments, in time order, before the write-offs are split out. */
  const dayAppointments = computed(() =>
    book.appointments.value
      .filter((appointment) => shop.localDate(appointment.startAt) === input.date.value)
      .slice()
      .sort((a, b) => a.startAt.localeCompare(b.startAt)),
  );

  /** Cancellations and no-shows, kept apart so a page can fold them away. */
  const voids = computed(() =>
    dayAppointments.value.filter(
      (appointment) => appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW',
    ),
  );

  /**
   * Today's walk-ins headed for this chair.
   *
   * `assignedBarberId` rather than `requestedBarberId`, because the estimator's projection
   * is exactly what is being shown — but only where it has produced a time, since an entry
   * it cannot place has nowhere to sit on a list ordered by time.
   */
  const chairWalkIns = computed<QueueEntryDto[]>(() => {
    if (input.barberId.value === null) return [];
    return (queue.board.value?.entries ?? []).filter(
      (entry) =>
        entry.assignedBarberId === input.barberId.value &&
        entry.estimatedReadyAt !== null &&
        ACTIVE_WALK_IN.includes(entry.status),
    );
  });

  /** Gated on the day being today: a walk-in has no future date to appear on. */
  const walkIns = computed<QueueEntryDto[]>(() =>
    input.isToday.value ? chairWalkIns.value : [],
  );

  const items = computed<DayItem[]>(() =>
    [
      ...dayAppointments.value
        .filter(
          (appointment) => appointment.status !== 'CANCELLED' && appointment.status !== 'NO_SHOW',
        )
        .map(fromAppointment),
      ...walkIns.value.map(fromQueueEntry),
    ].sort((a, b) => a.startAt.localeCompare(b.startAt)),
  );

  return { dayAppointments, voids, chairWalkIns, walkIns, items };
}
