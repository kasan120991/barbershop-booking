/**
 * Resolved working intervals for the staff calendar.
 *
 * Answers "when is each barber meant to be behind the chair" for a run of local
 * dates — schedule ∩ shop hours, closures and time off applied, bookings left in.
 * The calendar shades everything outside these stretches as non-working and paints
 * appointments on top, which is why the busy-subtraction half of the availability
 * engine is deliberately absent here.
 *
 * One batched fetch for the whole window, mirroring `loadDaySnapshots`: the day
 * board asks for every chair and the week view asks for seven days, and either
 * shape looped over a per-day loader is a query storm on a screen that refreshes
 * every minute.
 */

import type { WorkingHoursResponse } from '@francis/shared';
import { DateTime } from 'luxon';

import { ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { computeScheduledIntervals, localDayWindow } from './availability.js';
import { getShopSettings } from './catalog.js';

export interface WorkingHoursInput {
  /** First local date, "YYYY-MM-DD" in the shop's zone. */
  from: string;
  days: number;
  /** Restrict to one barber. Omitted: every ACTIVE barber, in roster order. */
  barberId?: string | undefined;
}

export async function getWorkingHours(input: WorkingHoursInput): Promise<WorkingHoursResponse> {
  const { timezone } = await getShopSettings();

  const first = DateTime.fromISO(input.from, { zone: timezone }).startOf('day');
  if (!first.isValid) throw new ValidationError('That date could not be understood.');

  const dates = Array.from({ length: input.days }, (_, i) =>
    first.plus({ days: i }).toFormat('yyyy-MM-dd'),
  );
  const windowStart = localDayWindow(dates[0]!, timezone).start;
  const windowEnd = localDayWindow(dates.at(-1)!, timezone).end;

  const barbers = await prisma.barber.findMany({
    where: input.barberId === undefined ? { status: 'ACTIVE' } : { id: input.barberId },
    select: { id: true },
    orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
  });
  const barberIds = barbers.map((barber) => barber.id);

  const [schedules, hours, closures, exceptions] = await Promise.all([
    prisma.barberSchedule.findMany({ where: { barberId: { in: barberIds } } }),
    prisma.shopHours.findMany(),
    prisma.shopClosure.findMany({
      where: { startAt: { lt: windowEnd }, endAt: { gt: windowStart } },
    }),
    prisma.scheduleException.findMany({
      where: {
        barberId: { in: barberIds },
        startAt: { lt: windowEnd },
        endAt: { gt: windowStart },
      },
    }),
  ]);

  const shopClosures = closures.map((closure) => ({ start: closure.startAt, end: closure.endAt }));

  const days = dates.map((date) => ({
    date,
    barbers: barberIds.map((barberId) => {
      const scheduled = computeScheduledIntervals({
        date,
        timezone,
        barberSchedules: schedules.filter((row) => row.barberId === barberId),
        shopHours: hours,
        shopClosures,
        scheduleExceptions: exceptions.filter((row) => row.barberId === barberId),
      });
      return {
        barberId,
        intervals: scheduled.intervals.map((interval) => ({
          startAt: interval.start.toISOString(),
          endAt: interval.end.toISOString(),
        })),
        reason: scheduled.reason,
      };
    }),
  }));

  return { timezone, days };
}
