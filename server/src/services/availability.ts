/**
 * The availability engine.
 *
 * Answers one question: given a barber, a local date, and a total service duration,
 * which start times can actually be booked?
 *
 * Split deliberately in two. `computeAvailability` is **pure** — it takes a snapshot
 * and returns slots, with `now` passed in rather than read from the clock, so a DST
 * boundary or a "too soon to book" rule can be exercised in a test instead of waited
 * for. `getAvailability` is the thin loader that fetches the snapshot and calls it.
 *
 * The hard part is not the arithmetic, it is the timezone. A weekly rule says "10:00
 * on Tuesdays", which is a different UTC instant in January and July, and on the two
 * transition days a local day is 23 or 25 hours long. Every local-to-UTC conversion
 * here goes through luxon against the specific date — never by adding a fixed offset.
 */

import { MINUTES_IN_DAY } from '@francis/shared';
import { DateTime } from 'luxon';

import type { ScheduleExceptionType } from '../generated/prisma/enums.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import {
  intersectIntervals,
  mergeIntervals,
  padEnd,
  subtractIntervals,
  type Interval,
} from './intervals.js';

export interface WeeklyRule {
  dayOfWeek: number;
  /** Minutes from LOCAL midnight. */
  startMinute: number;
  endMinute: number;
}

/**
 * Shop hours use `openMinute`/`closeMinute`, NOT the `startMinute`/`endMinute` a
 * barber shift uses — they are different tables with different column names, and
 * modelling them as the same shape reads `undefined` and silently produces a
 * zero-length interval that gets dropped as invalid.
 */
export interface ShopHoursRule {
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
  isClosed: boolean;
}

export interface DatedException {
  type: ScheduleExceptionType;
  startAt: Date;
  endAt: Date;
}

export interface AvailabilityInput {
  /** Local calendar date in the shop's zone, "YYYY-MM-DD". */
  date: string;
  timezone: string;
  /** Total across every requested service. */
  durationMinutes: number;
  slotGranularityMinutes: number;
  bufferMinutes: number;
  minimumNoticeMinutes: number;
  bookingHorizonDays: number;
  /** Injected so tests are deterministic. */
  now: Date;

  barberSchedules: WeeklyRule[];
  shopHours: ShopHoursRule[];
  /** UTC instants; `endAt` exclusive. */
  shopClosures: Interval[];
  scheduleExceptions: DatedException[];
  /**
   * Everything already committed on this barber's day — appointments now, and the
   * live queue from Phase 6. A generic list so the queue plugs in without a redesign.
   */
  busy: Interval[];
}

export interface AvailabilityResult {
  /** Bookable start instants, ascending. */
  slots: Date[];
  /** Free stretches after every rule, for explaining an empty result. */
  freeIntervals: Interval[];
  /** Populated when there are no slots, so the UI can say why rather than "none". */
  reason: string | null;
}

/**
 * Resolves a local minute-offset on a specific date to a UTC instant.
 *
 * Sets the wall-clock time rather than adding minutes to midnight, and the
 * difference only shows up twice a year — which is why it has a test.
 *
 * "Works 10:00–13:00" is a statement about the clock on the wall: the barber turns up
 * when it reads 10:00. Adding 600 *real* minutes to local midnight gives 11:00 on a
 * spring-forward day, because the hour between 02:00 and 03:00 never happened. Same
 * rule, wrong hour, on exactly the day nobody is checking.
 *
 * `set` also handles the two pathological times sanely: luxon pushes a
 * non-existent local time (02:30 on spring-forward) forward, and resolves an
 * ambiguous one (01:30 on fall-back) to its first occurrence.
 */
function localMinuteToUtc(date: string, timezone: string, minutes: number): Date {
  const dayStart = DateTime.fromISO(date, { zone: timezone }).startOf('day');

  // 1440 means midnight at the END of the day — an hour of 24 does not exist, and
  // `plus({ days: 1 })` is calendar-aware, so it is right on a 23- or 25-hour day.
  if (minutes >= MINUTES_IN_DAY) {
    return dayStart.plus({ days: 1 }).startOf('day').toUTC().toJSDate();
  }

  return dayStart
    .set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

/** Turns weekly rules for the given weekday into dated UTC intervals. */
function rulesToIntervals(
  rules: WeeklyRule[],
  dayOfWeek: number,
  date: string,
  timezone: string,
): Interval[] {
  return rules
    .filter((rule) => rule.dayOfWeek === dayOfWeek)
    .map((rule) => ({
      start: localMinuteToUtc(date, timezone, rule.startMinute),
      end: localMinuteToUtc(date, timezone, rule.endMinute),
    }));
}

export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const dayStart = DateTime.fromISO(input.date, { zone: input.timezone }).startOf('day');
  if (!dayStart.isValid) {
    throw new ValidationError('That date could not be understood.');
  }

  const dayEnd = dayStart.plus({ days: 1 });
  const dayWindow: Interval = { start: dayStart.toUTC().toJSDate(), end: dayEnd.toUTC().toJSDate() };
  // `.weekday` is Monday=1..Sunday=7; the schema is Sunday=0..Saturday=6.
  const dayOfWeek = dayStart.weekday % 7;

  const empty = (reason: string): AvailabilityResult => ({ slots: [], freeIntervals: [], reason });

  // Beyond the horizon, or in the past — nothing is bookable regardless of hours.
  const horizonEnd = DateTime.fromJSDate(input.now)
    .setZone(input.timezone)
    .startOf('day')
    .plus({ days: input.bookingHorizonDays });
  if (dayStart > horizonEnd) {
    return empty(`Bookings only open ${String(input.bookingHorizonDays)} days ahead.`);
  }

  // 1. When is the shop open on this weekday? Normalized to the shift shape first,
  //    because the two tables name their columns differently.
  const openRules: WeeklyRule[] = input.shopHours
    .filter((rule) => !rule.isClosed)
    .map((rule) => ({
      dayOfWeek: rule.dayOfWeek,
      startMinute: rule.openMinute,
      endMinute: rule.closeMinute,
    }));
  let shopOpen = rulesToIntervals(openRules, dayOfWeek, input.date, input.timezone);
  if (shopOpen.length === 0) return empty('The shop is closed on this day.');

  // Holidays beat opening hours.
  shopOpen = subtractIntervals(shopOpen, input.shopClosures);
  if (shopOpen.length === 0) return empty('The shop is closed on this date.');

  // 2. When is the barber scheduled?
  let working = rulesToIntervals(input.barberSchedules, dayOfWeek, input.date, input.timezone);

  // 3. Extra hours grant time the weekly pattern does not include, so they are added
  //    before anything is subtracted.
  const extraHours = input.scheduleExceptions
    .filter((exception) => exception.type === 'EXTRA_HOURS')
    .map((exception) => ({ start: exception.startAt, end: exception.endAt }));
  working = mergeIntervals([...working, ...intersectIntervals(extraHours, [dayWindow])]);

  if (working.length === 0) return empty('This barber is not working on this day.');

  // 4. Working AND open.
  let free = intersectIntervals(working, shopOpen);
  if (free.length === 0) return empty('This barber is not working while the shop is open.');

  // 5. Time off and mid-day blocks.
  const timeOff = input.scheduleExceptions
    .filter((exception) => exception.type !== 'EXTRA_HOURS')
    .map((exception) => ({ start: exception.startAt, end: exception.endAt }));
  free = subtractIntervals(free, timeOff);
  if (free.length === 0) return empty('This barber is off on this date.');

  // 6. Existing commitments, each extended by the turnaround buffer so the next
  //    client is not seated the instant the previous one stands up.
  free = subtractIntervals(free, padEnd(input.busy, input.bufferMinutes));
  if (free.length === 0) return empty('Fully booked.');

  // 7. Candidate starts on the granularity grid, anchored to LOCAL midnight so the
  //    grid lines up with the clock a human reads rather than drifting with UTC.
  const earliest = new Date(input.now.getTime() + input.minimumNoticeMinutes * 60_000);
  const durationMs = input.durationMinutes * 60_000;
  const slots: Date[] = [];

  for (let minute = 0; minute < MINUTES_IN_DAY; minute += input.slotGranularityMinutes) {
    const start = localMinuteToUtc(input.date, input.timezone, minute);
    const end = new Date(start.getTime() + durationMs);

    if (start < earliest) continue;

    // The WHOLE appointment has to fit inside one free stretch — a slot that starts
    // in the morning and runs through lunch is not bookable.
    const fits = free.some(
      (interval) => start >= interval.start && end <= interval.end,
    );
    if (fits) slots.push(start);
  }

  if (slots.length === 0) {
    return {
      slots: [],
      freeIntervals: free,
      reason:
        input.durationMinutes > 0
          ? 'No opening long enough for this service.'
          : 'Nothing available.',
    };
  }

  return { slots, freeIntervals: free, reason: null };
}

// --- Loader ------------------------------------------------------------------

export interface AvailabilityQuery {
  barberId: string;
  /** Local date, "YYYY-MM-DD". */
  date: string;
  serviceIds: string[];
  now?: Date;
}

/**
 * Fetches the snapshot and runs the engine.
 *
 * Duration comes from the `Service` rows, never from the caller — the same rule that
 * governs price. A client that could name its own duration could book a 5-minute
 * "haircut" into a gap that will not hold one.
 */
export async function getAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
  const now = query.now ?? new Date();

  const [settings, barber, services] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { id: 1 } }),
    prisma.barber.findUnique({ where: { id: query.barberId } }),
    prisma.service.findMany({ where: { id: { in: query.serviceIds } } }),
  ]);

  if (!settings) throw new NotFoundError('Shop settings have not been set up.');
  if (!barber) throw new NotFoundError('Barber not found.');
  if (services.length !== query.serviceIds.length) {
    throw new ValidationError('One of those services no longer exists.');
  }

  const durationMinutes = services.reduce((total, service) => total + service.durationMinutes, 0);
  if (durationMinutes <= 0) throw new ValidationError('Choose at least one service.');

  const dayStart = DateTime.fromISO(query.date, { zone: settings.timezone }).startOf('day');
  if (!dayStart.isValid) throw new ValidationError('That date could not be understood.');
  const windowStart = dayStart.toUTC().toJSDate();
  const windowEnd = dayStart.plus({ days: 1 }).toUTC().toJSDate();

  const [schedules, hours, closures, exceptions, appointments] = await Promise.all([
    prisma.barberSchedule.findMany({ where: { barberId: query.barberId } }),
    prisma.shopHours.findMany(),
    prisma.shopClosure.findMany({
      where: { startAt: { lt: windowEnd }, endAt: { gt: windowStart } },
    }),
    prisma.scheduleException.findMany({
      where: {
        barberId: query.barberId,
        startAt: { lt: windowEnd },
        endAt: { gt: windowStart },
      },
    }),
    prisma.appointment.findMany({
      where: {
        barberId: query.barberId,
        // CANCELLED and NO_SHOW free the chair; BOOKED and IN_PROGRESS do not.
        status: { in: ['BOOKED', 'IN_PROGRESS'] },
        startAt: { lt: windowEnd },
        endAt: { gt: windowStart },
      },
      select: { startAt: true, endAt: true },
    }),
  ]);

  return computeAvailability({
    date: query.date,
    timezone: settings.timezone,
    durationMinutes,
    slotGranularityMinutes: settings.slotGranularityMinutes,
    bufferMinutes: settings.bufferMinutes,
    minimumNoticeMinutes: settings.minimumNoticeMinutes,
    bookingHorizonDays: settings.bookingHorizonDays,
    now,
    barberSchedules: schedules,
    shopHours: hours,
    shopClosures: closures.map((closure) => ({ start: closure.startAt, end: closure.endAt })),
    scheduleExceptions: exceptions,
    busy: appointments.map((appointment) => ({
      start: appointment.startAt,
      end: appointment.endAt,
    })),
  });
}
