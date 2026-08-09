/**
 * Barber weekly schedules and time off.
 *
 * The week is replaced wholesale in one transaction, exactly as `replaceShopHours`
 * does — a half-applied week would make the slot engine read missing days as "not
 * working", which is a silent wrong answer rather than a visible failure.
 *
 * Overlap validation is imported from `@francis/shared` rather than written here, so
 * the editor can refuse a bad week before the round trip and the API refuses it
 * regardless, using one implementation.
 */

import {
  EXCEPTION_KIND,
  findScheduleProblems,
  timeStringToMinutes,
  type CreateScheduleExceptionRequest,
  type ExceptionKind,
  type ScheduleExceptionDto,
  type ShiftRange,
} from '@francis/shared';
import { DateTime } from 'luxon';

import type { ScheduleExceptionType } from '../generated/prisma/enums.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { getShopSettings } from './catalog.js';

export function listBarberSchedule(barberId: string) {
  return prisma.barberSchedule.findMany({
    where: { barberId },
    orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
  });
}

export async function assertBarberExists(barberId: string): Promise<void> {
  const barber = await prisma.barber.findUnique({ where: { id: barberId }, select: { id: true } });
  if (!barber) throw new NotFoundError('Barber not found.');
}

/**
 * Replaces the barber's whole week.
 *
 * Delete-then-insert in one transaction. Validation runs first so a rejected week
 * never touches the existing rows — an admin whose input was refused should still
 * have the schedule they had a moment ago.
 */
export async function replaceBarberSchedule(
  barberId: string,
  shifts: ShiftRange[],
): Promise<void> {
  await assertBarberExists(barberId);

  const problems = findScheduleProblems(shifts);
  if (problems.length > 0) {
    // Every problem, not just the first, so the editor can mark all the bad rows.
    throw new ValidationError(problems.map((problem) => problem.message).join(' '));
  }

  await prisma.$transaction([
    prisma.barberSchedule.deleteMany({ where: { barberId } }),
    ...(shifts.length === 0
      ? []
      : [
          prisma.barberSchedule.createMany({
            data: shifts.map((shift) => ({
              barberId,
              dayOfWeek: shift.dayOfWeek,
              startMinute: shift.startMinute,
              endMinute: shift.endMinute,
            })),
          }),
        ]),
  ]);
}

// --- Exceptions --------------------------------------------------------------

/**
 * The stored type is derived from what the admin chose plus whether it is all day.
 *
 * TIME_OFF and BLOCK both remove availability, so the UI offers one "Time off"
 * choice; keeping them distinct in the database preserves the difference between a
 * holiday and a mid-day errand for later reporting.
 */
function storedType(kind: ExceptionKind, allDay: boolean): ScheduleExceptionType {
  if (kind === EXCEPTION_KIND.EXTRA_HOURS) return 'EXTRA_HOURS';
  return allDay ? 'TIME_OFF' : 'BLOCK';
}

export async function createScheduleException(
  barberId: string,
  input: CreateScheduleExceptionRequest,
): Promise<ScheduleExceptionDto> {
  await assertBarberExists(barberId);

  const { timezone } = await getShopSettings();
  const endDate = input.endDate ?? input.startDate;

  let startAt: DateTime;
  let endAt: DateTime;

  if (input.allDay) {
    // Local midnight to midnight of the day AFTER the last closed day — the same
    // exclusive-end convention shop closures use, so the two cannot drift apart.
    startAt = DateTime.fromISO(input.startDate, { zone: timezone }).startOf('day');
    endAt = DateTime.fromISO(endDate, { zone: timezone }).plus({ days: 1 }).startOf('day');
  } else {
    const startMinute = timeStringToMinutes(input.startTime ?? '');
    const endMinute = timeStringToMinutes(input.endTime ?? '');
    if (startMinute === null || endMinute === null) {
      throw new ValidationError('Those times could not be read.');
    }

    startAt = DateTime.fromISO(input.startDate, { zone: timezone })
      .startOf('day')
      .plus({ minutes: startMinute });
    endAt = DateTime.fromISO(endDate, { zone: timezone })
      .startOf('day')
      .plus({ minutes: endMinute });
  }

  if (!startAt.isValid || !endAt.isValid) {
    throw new ValidationError('That date could not be understood.');
  }
  if (endAt <= startAt) {
    throw new ValidationError('The end must be after the start.');
  }

  const created = await prisma.scheduleException.create({
    data: {
      barberId,
      type: storedType(input.kind as ExceptionKind, input.allDay),
      startAt: startAt.toUTC().toJSDate(),
      endAt: endAt.toUTC().toJSDate(),
      reason: input.reason ?? null,
    },
  });

  return toExceptionDto(created, timezone);
}

export async function listScheduleExceptions(
  barberId: string,
  options: { from?: Date } = {},
): Promise<ScheduleExceptionDto[]> {
  const { timezone } = await getShopSettings();

  const exceptions = await prisma.scheduleException.findMany({
    where: {
      barberId,
      // Anything still running counts as upcoming, so a holiday you are in the
      // middle of does not vanish from the list.
      ...(options.from === undefined ? {} : { endAt: { gte: options.from } }),
    },
    orderBy: { startAt: 'asc' },
  });

  return exceptions.map((exception) => toExceptionDto(exception, timezone));
}

export async function deleteScheduleException(exceptionId: string): Promise<{ barberId: string }> {
  const exception = await prisma.scheduleException.findUnique({ where: { id: exceptionId } });
  if (!exception) throw new NotFoundError('That entry no longer exists.');

  await prisma.scheduleException.delete({ where: { id: exceptionId } });
  return { barberId: exception.barberId };
}

export function toExceptionDto(
  exception: {
    id: string;
    barberId: string;
    type: ScheduleExceptionType;
    startAt: Date;
    endAt: Date;
    reason: string | null;
  },
  timezone: string,
): ScheduleExceptionDto {
  const start = DateTime.fromJSDate(exception.startAt).setZone(timezone);
  const end = DateTime.fromJSDate(exception.endAt).setZone(timezone);

  // All-day rows sit exactly on local midnight at both ends.
  const allDay =
    exception.type !== 'EXTRA_HOURS' &&
    start.hour === 0 &&
    start.minute === 0 &&
    end.hour === 0 &&
    end.minute === 0;

  return {
    id: exception.id,
    barberId: exception.barberId,
    kind: exception.type === 'EXTRA_HOURS' ? EXCEPTION_KIND.EXTRA_HOURS : EXCEPTION_KIND.TIME_OFF,
    startDate: start.toFormat('yyyy-MM-dd'),
    // The exclusive end means the last affected day is the one before.
    endDate: (allDay ? end.minus({ days: 1 }) : end).toFormat('yyyy-MM-dd'),
    allDay,
    startTime: allDay ? null : start.toFormat('HH:mm'),
    endTime: allDay ? null : end.toFormat('HH:mm'),
    reason: exception.reason,
  };
}
