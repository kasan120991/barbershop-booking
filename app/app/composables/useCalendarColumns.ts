/**
 * Assembly for the time-grid views: instants in, minutes out.
 *
 * `TimeGrid.vue` deliberately knows nothing about timezones — it positions blocks
 * by minutes past the shop-local midnight. This composable is where an
 * appointment's UTC instants, a queue entry's moving estimate, and the working
 * intervals from `/working-hours` all become those minutes, through
 * `useShopClock.minuteOfDay` and nothing else. Wall-clock positioning is what
 * makes a 23- or 25-hour day render correctly without anyone doing DST
 * arithmetic here.
 *
 * A walk-in block's end does not exist anywhere — a queue entry has no `endAt` —
 * so it is derived as `estimatedReadyAt + durationMinutes`, the same sum the
 * server's own `loadQueueCommitments` uses.
 */

import {
  assignLanes,
  type AppointmentDto,
  type QueueEntryDto,
  type WorkingHoursBarberDayDto,
} from '@francis/shared';

export interface MinuteSpan {
  startMinute: number;
  endMinute: number;
}

/** What a block says about itself — everything `CalendarBlock.vue` renders. */
export interface CalendarBlockData {
  clientName: string;
  services: string;
  /** Appointment status, or queue status for a walk-in. */
  status: string;
  /** A queue entry rather than an appointment. */
  projected: boolean;
  /** True only while the estimate can still move — a waiting walk-in. */
  moving: boolean;
  /** Today's first booked cut that has not started. */
  next: boolean;
  startAt: string;
  endAt: string | null;
  durationMinutes: number;
  appointment: AppointmentDto | null;
}

export interface TimeGridBlock extends MinuteSpan {
  key: string;
  lane: number;
  laneCount: number;
  kind: 'solid' | 'projected' | 'void';
  data: CalendarBlockData;
}

export interface TimeGridColumn {
  key: string;
  today: boolean;
  /** Working stretches; everything outside them is drawn as absence. */
  working: MinuteSpan[];
  /** The engine's sentence for a day with no working time. */
  reason: string | null;
  blocks: TimeGridBlock[];
}

export interface ColumnInput {
  key: string;
  today: boolean;
  /** Already filtered to this column's barber and date. */
  appointments: AppointmentDto[];
  /** Already filtered to assigned-here, estimated, active. Today only. */
  queueEntries: QueueEntryDto[];
  workingDay: WorkingHoursBarberDayDto | null;
  showVoids: boolean;
}

export function useCalendarColumns() {
  const shop = useShopClock();

  function spanOf(startAt: string, endAt: string | null, durationMinutes: number): MinuteSpan {
    const startMinute = shop.minuteOfDay(startAt);
    if (endAt === null) return { startMinute, endMinute: startMinute + durationMinutes };
    const endMinute = shop.minuteOfDay(endAt);
    // An end on the stroke of the next midnight reads as minute 0.
    return { startMinute, endMinute: endMinute > startMinute ? endMinute : 1440 };
  }

  function buildColumn(input: ColumnInput): TimeGridColumn {
    const ordered = input.appointments
      .slice()
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    const nextId = input.today
      ? (ordered.find((appointment) => appointment.status === 'BOOKED')?.id ?? null)
      : null;

    const blocks: Omit<TimeGridBlock, 'lane' | 'laneCount'>[] = [];

    for (const appointment of ordered) {
      const voided = appointment.status === 'CANCELLED' || appointment.status === 'NO_SHOW';
      if (voided && !input.showVoids) continue;
      blocks.push({
        key: appointment.id,
        ...spanOf(appointment.startAt, appointment.endAt, appointment.durationMinutes),
        kind: voided ? 'void' : 'solid',
        data: {
          clientName: appointment.clientName,
          services: appointment.services.map((service) => service.name).join(' + '),
          status: appointment.status,
          projected: false,
          moving: false,
          next: appointment.id === nextId,
          startAt: appointment.startAt,
          endAt: appointment.endAt,
          durationMinutes: appointment.durationMinutes,
          appointment,
        },
      });
    }

    for (const entry of input.queueEntries) {
      if (entry.estimatedReadyAt === null) continue;
      const moving = entry.status === 'WAITING';
      blocks.push({
        key: `queue:${entry.id}`,
        ...spanOf(entry.estimatedReadyAt, null, entry.durationMinutes),
        // Dashed only while it can still move. Somebody in the chair is not a guess.
        kind: moving ? 'projected' : 'solid',
        data: {
          clientName: entry.clientName,
          services: entry.services.map((service) => service.name).join(' + '),
          status: entry.status,
          projected: true,
          moving,
          next: false,
          startAt: entry.estimatedReadyAt,
          endAt: null,
          durationMinutes: entry.durationMinutes,
          appointment: null,
        },
      });
    }

    const placements = assignLanes(blocks);

    return {
      key: input.key,
      today: input.today,
      working: (input.workingDay?.intervals ?? []).map((interval) =>
        spanOf(interval.startAt, interval.endAt, 0),
      ),
      reason: input.workingDay?.reason ?? null,
      blocks: blocks.map((block, index) => ({
        ...block,
        lane: placements[index]?.lane ?? 0,
        laneCount: placements[index]?.laneCount ?? 1,
      })),
    };
  }

  /**
   * The vertical extent one grid should draw: everything that exists, padded out
   * to the hour. A day with nothing at all still gets a working day's worth of
   * axis — a blank strip three lines tall would read as broken, not quiet.
   */
  function gridExtent(columns: TimeGridColumn[]): MinuteSpan {
    let min = Infinity;
    let max = -Infinity;
    for (const column of columns) {
      for (const span of [...column.working, ...column.blocks]) {
        min = Math.min(min, span.startMinute);
        max = Math.max(max, span.endMinute);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      return { startMinute: 480, endMinute: 1200 };
    }
    return {
      startMinute: Math.max(0, Math.floor(min / 60) * 60),
      endMinute: Math.min(1440, Math.ceil(max / 60) * 60),
    };
  }

  return { buildColumn, gridExtent };
}
