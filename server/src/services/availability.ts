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
import { listBarbers } from './catalog.js';
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
 * The schedule half of the question: when is this barber meant to be behind the
 * chair on this date, before anyone books a minute of it?
 *
 * Split out from `FreeTimeInput` because the staff calendar needs exactly this and
 * nothing more — it draws working time as ground and appointments as blocks on top,
 * so subtracting the busy time here would erase the very thing it renders onto.
 */
export interface ScheduledTimeInput {
  /** Local calendar date in the shop's zone, "YYYY-MM-DD". */
  date: string;
  timezone: string;

  barberSchedules: WeeklyRule[];
  shopHours: ShopHoursRule[];
  /** UTC instants; `endAt` exclusive. */
  shopClosures: Interval[];
  scheduleExceptions: DatedException[];
}

export interface ScheduledTimeResult {
  /** Working stretches after every schedule rule, ascending. Empty when `reason` is set. */
  intervals: Interval[];
  /** Why there is no working time, so a caller can explain rather than shrug. */
  reason: string | null;
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
export interface FreeTimeInput extends ScheduledTimeInput {
  bufferMinutes: number;
  bookingHorizonDays: number;
  /** Injected so tests are deterministic. */
  now: Date;

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
 * When is this barber scheduled to work on this date, closures and time off applied?
 *
 * Order matters and is not interchangeable: extra hours are *added* before anything
 * is subtracted, because they grant time the weekly pattern does not contain; time
 * off is subtracted after, because it overrides both.
 *
 * Deliberately knows nothing about the booking horizon or existing bookings — the
 * staff calendar reads this to shade non-working time, and it looks both past the
 * horizon and at days that are fully booked.
 */
export function computeScheduledIntervals(input: ScheduledTimeInput): ScheduledTimeResult {
  const dayStart = DateTime.fromISO(input.date, { zone: input.timezone }).startOf('day');
  if (!dayStart.isValid) {
    throw new ValidationError('That date could not be understood.');
  }

  const dayEnd = dayStart.plus({ days: 1 });
  const dayWindow: Interval = { start: dayStart.toUTC().toJSDate(), end: dayEnd.toUTC().toJSDate() };
  // `.weekday` is Monday=1..Sunday=7; the schema is Sunday=0..Saturday=6.
  const dayOfWeek = dayStart.weekday % 7;

  const empty = (reason: string): ScheduledTimeResult => ({ intervals: [], reason });

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
  let scheduled = intersectIntervals(working, shopOpen);
  if (scheduled.length === 0) return empty('This barber is not working while the shop is open.');

  // 5. Time off and mid-day blocks.
  const timeOff = input.scheduleExceptions
    .filter((exception) => exception.type !== 'EXTRA_HOURS')
    .map((exception) => ({ start: exception.startAt, end: exception.endAt }));
  scheduled = subtractIntervals(scheduled, timeOff);
  if (scheduled.length === 0) return empty('This barber is off on this date.');

  return { intervals: scheduled, reason: null };
}

/** When is this barber actually free on this date? */
export function computeFreeIntervals(input: FreeTimeInput): FreeTimeResult {
  const dayStart = DateTime.fromISO(input.date, { zone: input.timezone }).startOf('day');
  if (!dayStart.isValid) {
    throw new ValidationError('That date could not be understood.');
  }

  // Beyond the horizon, or in the past — nothing is bookable regardless of hours.
  const horizonEnd = DateTime.fromJSDate(input.now)
    .setZone(input.timezone)
    .startOf('day')
    .plus({ days: input.bookingHorizonDays });
  if (dayStart > horizonEnd) {
    return { free: [], reason: `Bookings only open ${String(input.bookingHorizonDays)} days ahead.` };
  }

  const scheduled = computeScheduledIntervals(input);
  if (scheduled.reason !== null) return { free: [], reason: scheduled.reason };

  // 6. Existing commitments, each extended by the turnaround buffer so the next
  //    client is not seated the instant the previous one stands up.
  const free = subtractIntervals(scheduled.intervals, padEnd(input.busy, input.bufferMinutes));
  if (free.length === 0) return { free: [], reason: 'Fully booked.' };

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

// --- Finding the next opening ------------------------------------------------

export interface NextAvailableQuery {
  serviceIds: string[];
  /** Restrict to one chair; omitted fans out across every eligible barber. */
  barberId?: string;
  /** Local shop date to start scanning from. Defaults to today. */
  fromDate?: string;
  /** Only offer starts at or after this instant — "later today", "after four". */
  after?: Date;
  /** Most offers to return. Three is what somebody on the phone can hold in their head. */
  limit?: number;
  /** Hard cap on local days scanned, before the booking horizon is applied. */
  maxDays?: number;
  /** Whether `acceptsOnline` and `bookableOnline` narrow the set. */
  enforceOnlineRules: boolean;
  now?: Date;
}

export interface NextAvailableOffer {
  barberId: string;
  barberName: string;
  /** A concrete UTC instant in a named barber's book. Never an unassigned slot. */
  startAt: Date;
}

export interface NextAvailableResult {
  offers: NextAvailableOffer[];
  durationMinutes: number;
  /** Populated only when `offers` is empty, so a caller can say why rather than "none". */
  reason: string | null;
}

const DEFAULT_MAX_DAYS = 14;
const DEFAULT_LIMIT = 3;

/**
 * "When is the next opening?" — across every barber who can do the job.
 *
 * The booking site answers this in the client: it asks each eligible barber for a day and
 * merges the results. A phone caller cannot fan out, so the server has to. This is
 * server-side *resolution*, not an unassigned appointment — every offer names a barber,
 * because picking a time picks a person and the confirmation has to say who.
 *
 * Built on `loadDaySnapshots`, which is already plural and answers in five queries for
 * any number of barbers. Looping `getAvailability` instead would be five queries per
 * barber per day, which for a four-chair shop scanning a fortnight is 280.
 *
 * **It stops at the first day with anything on it**, so the usual call costs one day's
 * queries, and every offer it returns is on the same date — which is also what makes the
 * answer speakable. "I've got three times on Thursday" is a sentence; one on Thursday and
 * one a fortnight later is a list.
 */
export async function findNextAvailable(query: NextAvailableQuery): Promise<NextAvailableResult> {
  const now = query.now ?? new Date();
  const limit = query.limit ?? DEFAULT_LIMIT;

  const [settings, services] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { id: 1 } }),
    prisma.service.findMany({ where: { id: { in: query.serviceIds } } }),
  ]);

  if (!settings) throw new NotFoundError('Shop settings have not been set up.');
  if (services.length !== new Set(query.serviceIds).size) {
    throw new ValidationError('One of those services no longer exists.');
  }

  const durationMinutes = services.reduce((total, service) => total + service.durationMinutes, 0);
  if (durationMinutes <= 0) throw new ValidationError('Choose at least one service.');

  const inactive = services.find((service) => !service.isActive);
  if (inactive) throw new ValidationError(`${inactive.name} is no longer offered.`);

  const notOnline = query.enforceOnlineRules
    ? services.find((service) => !service.bookableOnline)
    : undefined;
  if (notOnline) throw new ValidationError(`${notOnline.name} has to be booked by phone.`);

  /**
   * Capability is filtered HERE rather than left to the caller.
   *
   * The booking clients narrow the roster before they ever show a chair, so
   * `getAvailability` has never had to. A voice caller has no such list in front of
   * them, so offering a time with a barber who does not do beards would be a booking the
   * shop cannot honour.
   */
  const roster = await listBarbers({
    includeInactive: false,
    serviceIds: query.serviceIds,
    ...(query.enforceOnlineRules ? { acceptsOnline: true } : {}),
  });

  const barbers =
    query.barberId === undefined
      ? roster
      : roster.filter((barber) => barber.id === query.barberId);

  if (barbers.length === 0) {
    return {
      offers: [],
      durationMinutes,
      reason:
        query.barberId === undefined
          ? 'No barber on today does all of those services.'
          : 'That barber does not do all of those services.',
    };
  }

  const barberIds = barbers.map((barber) => barber.id);

  const today = DateTime.fromJSDate(now).setZone(settings.timezone).startOf('day');
  const start = query.fromDate
    ? DateTime.fromISO(query.fromDate, { zone: settings.timezone }).startOf('day')
    : today;
  if (!start.isValid) throw new ValidationError('That date could not be understood.');

  // Never scan a day that has already gone; "next available from last Tuesday" is today.
  const first = start < today ? today : start;
  const maxDays = Math.max(1, query.maxDays ?? DEFAULT_MAX_DAYS);

  /** The last reason any day produced, so an empty answer can still explain itself. */
  let lastReason: string | null = null;

  for (let offset = 0; offset < maxDays; offset += 1) {
    const day = first.plus({ days: offset });
    const date = day.toFormat('yyyy-MM-dd');

    // The engine reports the horizon itself, but scanning past it is pure waste — every
    // remaining day would return the same sentence.
    if (day.diff(today, 'days').days > settings.bookingHorizonDays) {
      return {
        offers: [],
        durationMinutes,
        reason: `Bookings only open ${String(settings.bookingHorizonDays)} days ahead.`,
      };
    }

    const window = localDayWindow(date, settings.timezone);
    const snapshots = await loadDaySnapshots(barberIds, date, settings.timezone);

    // The live queue only exists today, so every forward day skips the query entirely —
    // the same skip `getAvailability` makes, for the same reason.
    const isToday = date === today.toFormat('yyyy-MM-dd');
    const queueBusy = isToday
      ? await loadQueueCommitments(barberIds, window)
      : new Map<string, Interval[]>();

    const found: NextAvailableOffer[] = [];

    for (const barber of barbers) {
      const snapshot = snapshots.get(barber.id);
      if (!snapshot) continue;

      const result = computeAvailability({
        date,
        timezone: settings.timezone,
        durationMinutes,
        slotGranularityMinutes: settings.slotGranularityMinutes,
        bufferMinutes: settings.bufferMinutes,
        minimumNoticeMinutes: query.enforceOnlineRules ? settings.minimumNoticeMinutes : 0,
        bookingHorizonDays: settings.bookingHorizonDays,
        now,
        barberSchedules: snapshot.barberSchedules,
        shopHours: snapshot.shopHours,
        shopClosures: snapshot.shopClosures,
        scheduleExceptions: snapshot.scheduleExceptions,
        busy: [...snapshot.appointments, ...(queueBusy.get(barber.id) ?? [])],
      });

      if (result.reason !== null) lastReason = result.reason;

      for (const slot of result.slots) {
        if (query.after && slot < query.after) continue;
        found.push({
          barberId: barber.id,
          barberName: barber.displayName,
          startAt: slot,
        });
      }
    }

    if (found.length > 0) {
      // Earliest first; ties broken by the shop's own running order, so "any barber"
      // offers the chair the shop would offer, not whichever id sorted first.
      const order = new Map(barbers.map((barber, index) => [barber.id, index]));
      found.sort(
        (a, b) =>
          a.startAt.getTime() - b.startAt.getTime() ||
          (order.get(a.barberId) ?? 0) - (order.get(b.barberId) ?? 0),
      );

      /**
       * With no barber asked for, one offer per distinct TIME.
       *
       * Somebody who said "anyone" wants a choice of times, not the same time three ways.
       * Un-deduped, a three-chair shop that opens at ten answers "ten o'clock with Kasan,
       * ten o'clock with Andre, or ten o'clock with Rico" — which is one option read out
       * three times, and useless down a phone. The shop's running order decides who gets
       * offered each slot, which is the tie-break already applied above.
       *
       * When a barber WAS asked for there is nothing to dedupe: every offer is theirs, and
       * the times are already distinct.
       */
      let offers = found;

      if (query.barberId === undefined) {
        // Keeping the FIRST offer at each time, not the last. `new Map(entries)` would
        // keep the last and hand every tie to whichever chair sorts last — undoing the
        // sortOrder tie-break two lines above it.
        const byTime = new Map<number, NextAvailableOffer>();
        for (const offer of found) {
          const key = offer.startAt.getTime();
          if (!byTime.has(key)) byTime.set(key, offer);
        }
        offers = [...byTime.values()];
      }

      return { offers: offers.slice(0, limit), durationMinutes, reason: null };
    }
  }

  return {
    offers: [],
    durationMinutes,
    // The engine's own sentence when it gave one — the shop's words, not an invented
    // excuse — and a bounded one when the scan simply ran out of days.
    reason:
      lastReason ??
      `Nothing free in the next ${String(maxDays)} days. Please call the shop.`,
  };
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
