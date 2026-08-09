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

/**
 * Everything needed to work out when a barber is free — but not how that free time
 * gets carved into offerable start times.
 *
 * Split out because the walk-in queue needs exactly this half and nothing more: the
 * estimator places a waiting client into a gap, it does not offer them a grid of
 * choices. One implementation of the schedule algebra serves both, so a rule about
 * closures or extra hours can never be right in one and wrong in the other.
 */
export interface FreeTimeInput {
  /** Local calendar date in the shop's zone, "YYYY-MM-DD". */
  date: string;
  timezone: string;
  bufferMinutes: number;
  bookingHorizonDays: number;
  /** Injected so tests are deterministic. */
  now: Date;

  barberSchedules: WeeklyRule[];
  shopHours: ShopHoursRule[];
  /** UTC instants; `endAt` exclusive. */
  shopClosures: Interval[];
  scheduleExceptions: DatedException[];
  /**
   * Everything already committed on this barber's day — booked appointments, plus
   * the live queue when the caller is offering online slots.
   */
  busy: Interval[];
}

export interface AvailabilityInput extends FreeTimeInput {
  /** Total across every requested service. */
  durationMinutes: number;
  slotGranularityMinutes: number;
  minimumNoticeMinutes: number;
}

export interface FreeTimeResult {
  /** Free stretches after every rule, ascending. Empty when `reason` is set. */
  free: Interval[];
  /** Why there is no free time, so a caller can explain rather than shrug. */
  reason: string | null;
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

/**
 * When is this barber actually free on this date?
 *
 * Order matters and is not interchangeable: extra hours are *added* before anything
 * is subtracted, because they grant time the weekly pattern does not contain; time
 * off is subtracted after, because it overrides both.
 */
export function computeFreeIntervals(input: FreeTimeInput): FreeTimeResult {
  const dayStart = DateTime.fromISO(input.date, { zone: input.timezone }).startOf('day');
  if (!dayStart.isValid) {
    throw new ValidationError('That date could not be understood.');
  }

  const dayEnd = dayStart.plus({ days: 1 });
  const dayWindow: Interval = { start: dayStart.toUTC().toJSDate(), end: dayEnd.toUTC().toJSDate() };
  // `.weekday` is Monday=1..Sunday=7; the schema is Sunday=0..Saturday=6.
  const dayOfWeek = dayStart.weekday % 7;

  const empty = (reason: string): FreeTimeResult => ({ free: [], reason });

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

  return { free, reason: null };
}

export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const { free, reason } = computeFreeIntervals(input);
  if (reason !== null) return { slots: [], freeIntervals: [], reason };

  // Candidate starts on the granularity grid, anchored to LOCAL midnight so the grid
  // lines up with the clock a human reads rather than drifting with UTC.
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

/** One barber's day, as the engine wants it. */
export interface DaySnapshot {
  barberSchedules: WeeklyRule[];
  shopHours: ShopHoursRule[];
  shopClosures: Interval[];
  scheduleExceptions: DatedException[];
  /** Booked appointments only — see `loadQueueCommitments` for the walk-in half. */
  appointments: Interval[];
}

/** The UTC window covering one local calendar day in the shop's zone. */
export function localDayWindow(date: string, timezone: string): Interval {
  const dayStart = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  if (!dayStart.isValid) throw new ValidationError('That date could not be understood.');
  return {
    start: dayStart.toUTC().toJSDate(),
    end: dayStart.plus({ days: 1 }).toUTC().toJSDate(),
  };
}

/**
 * Loads the same day for several barbers at once.
 *
 * Written plural because the queue board needs every chair and the naive shape —
 * one loader called in a loop — is five queries per barber per refresh, on a screen
 * that refreshes constantly. Shop-wide rows are fetched once and shared.
 */
export async function loadDaySnapshots(
  barberIds: string[],
  date: string,
  timezone: string,
): Promise<Map<string, DaySnapshot>> {
  const window = localDayWindow(date, timezone);

  const [schedules, hours, closures, exceptions, appointments] = await Promise.all([
    prisma.barberSchedule.findMany({ where: { barberId: { in: barberIds } } }),
    prisma.shopHours.findMany(),
    prisma.shopClosure.findMany({
      where: { startAt: { lt: window.end }, endAt: { gt: window.start } },
    }),
    prisma.scheduleException.findMany({
      where: {
        barberId: { in: barberIds },
        startAt: { lt: window.end },
        endAt: { gt: window.start },
      },
    }),
    prisma.appointment.findMany({
      where: {
        barberId: { in: barberIds },
        // CANCELLED and NO_SHOW free the chair; BOOKED and IN_PROGRESS do not.
        status: { in: ['BOOKED', 'IN_PROGRESS'] },
        startAt: { lt: window.end },
        endAt: { gt: window.start },
      },
      select: { barberId: true, startAt: true, endAt: true },
    }),
  ]);

  const shopClosures = closures.map((closure) => ({ start: closure.startAt, end: closure.endAt }));

  return new Map(
    barberIds.map((barberId) => [
      barberId,
      {
        barberSchedules: schedules.filter((row) => row.barberId === barberId),
        shopHours: hours,
        shopClosures,
        scheduleExceptions: exceptions.filter((row) => row.barberId === barberId),
        appointments: appointments
          .filter((row) => row.barberId === barberId)
          .map((row) => ({ start: row.startAt, end: row.endAt })),
      },
    ]),
  );
}

/**
 * Time already promised to walk-ins, keyed by barber.
 *
 * Read from the persisted `estimatedReadyAt` rather than re-run through the estimator,
 * which is what keeps this free of a cycle: the queue schedules itself against
 * appointments, then availability schedules around both.
 *
 * Only entries attached to a specific barber count. An "anyone" walk-in still waiting
 * is genuinely not committed to a chair yet — `callNext` is what attaches them — so
 * blocking every barber's calendar on their behalf would be a guess, and a pessimistic
 * one that closes the online book for a client who may be seated in five minutes.
 */
export async function loadQueueCommitments(
  barberIds: string[],
  window: Interval,
): Promise<Map<string, Interval[]>> {
  const entries = await prisma.queueEntry.findMany({
    where: {
      barberId: { in: barberIds },
      status: { in: ['WAITING', 'CALLED', 'IN_CHAIR'] },
    },
    select: {
      barberId: true,
      durationMinutes: true,
      startedAt: true,
      calledAt: true,
      estimatedReadyAt: true,
    },
  });

  const byBarber = new Map<string, Interval[]>(barberIds.map((id) => [id, []]));

  for (const entry of entries) {
    if (entry.barberId === null) continue;
    // Someone in the chair started when they started; everyone else is where the
    // estimator last put them. No estimate at all means it cannot be reserved.
    const start = entry.startedAt ?? entry.estimatedReadyAt ?? entry.calledAt;
    if (start === null) continue;

    const end = new Date(start.getTime() + entry.durationMinutes * 60_000);
    if (start >= window.end || end <= window.start) continue;

    byBarber.get(entry.barberId)?.push({ start, end });
  }

  return byBarber;
}

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

  const window = localDayWindow(query.date, settings.timezone);
  const snapshots = await loadDaySnapshots([query.barberId], query.date, settings.timezone);
  const snapshot = snapshots.get(query.barberId);
  if (!snapshot) throw new NotFoundError('Barber not found.');

  /**
   * The live queue only exists today, so a forward-booking lookup — which is nearly
   * every lookup — skips the query entirely rather than paying for a table it cannot
   * have rows in.
   */
  const isToday =
    query.date === DateTime.fromJSDate(now).setZone(settings.timezone).toFormat('yyyy-MM-dd');
  const queueBusy = isToday
    ? ((await loadQueueCommitments([query.barberId], window)).get(query.barberId) ?? [])
    : [];

  return computeAvailability({
    date: query.date,
    timezone: settings.timezone,
    durationMinutes,
    slotGranularityMinutes: settings.slotGranularityMinutes,
    bufferMinutes: settings.bufferMinutes,
    minimumNoticeMinutes: settings.minimumNoticeMinutes,
    bookingHorizonDays: settings.bookingHorizonDays,
    now,
    barberSchedules: snapshot.barberSchedules,
    shopHours: snapshot.shopHours,
    shopClosures: snapshot.shopClosures,
    scheduleExceptions: snapshot.scheduleExceptions,
    // Both halves of "already spoken for": the calendar and the line at the door.
    busy: [...snapshot.appointments, ...queueBusy],
  });
}
