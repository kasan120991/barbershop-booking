/**
 * Barber onboarding, weekly schedules, and time off.
 *
 * Two conventions carried over deliberately from the catalog contracts:
 *
 * - **Weekly hours are minutes from local midnight**, never instants, so a recurring
 *   rule like "Tuesday 10:00" survives both clock changes a year.
 * - **Exceptions are local dates and times**, resolved against `ShopSettings.timezone`
 *   on the server. A day off is a statement about the shop's calendar, not about UTC.
 */

import { z } from 'zod';

import { BARBER_STATUS, ROLE } from '../enums.js';
import { LOCAL_DATE_PATTERN, MINUTES_IN_DAY } from '../time.js';

// --- Onboarding --------------------------------------------------------------

export const createBarberRequestSchema = z.object({
  firstName: z.string().trim().min(1, { error: 'Enter a first name.' }).max(60),
  lastName: z.string().trim().min(1, { error: 'Enter a last name.' }).max(60),
  email: z.email({ error: 'Enter a valid email address.' }),
  /** What clients see. Defaults to the first name when left blank. */
  displayName: z.string().trim().max(60).optional(),
  /**
   * Always includes BARBER — this creates a barber. ADMIN is additive, for the
   * owner-who-also-cuts case the whole role model exists for.
   */
  alsoAdmin: z.boolean().default(false),
  acceptsOnline: z.boolean().default(true),
  acceptsWalkIns: z.boolean().default(true),
  sortOrder: z.int().min(0).max(999).default(0),
});
export type CreateBarberRequest = z.infer<typeof createBarberRequestSchema>;

export const updateBarberRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(500).nullish(),
  sortOrder: z.int().min(0).max(999).optional(),
  status: z.enum(Object.values(BARBER_STATUS) as [string, ...string[]]).optional(),
  acceptsOnline: z.boolean().optional(),
  acceptsWalkIns: z.boolean().optional(),
});
export type UpdateBarberRequest = z.infer<typeof updateBarberRequestSchema>;

/** Returned once when a barber is created — read aloud, never retrievable again. */
export const createdBarberDtoSchema = z.object({
  barberId: z.string(),
  userId: z.string(),
  email: z.email(),
  displayName: z.string(),
  roles: z.array(z.enum(Object.values(ROLE) as [string, ...string[]])),
  temporaryPassword: z.string(),
});
export type CreatedBarberDto = z.infer<typeof createdBarberDtoSchema>;

// --- Weekly schedule ---------------------------------------------------------

export const barberScheduleDtoSchema = z.object({
  id: z.string(),
  dayOfWeek: z.int().min(0).max(6),
  startMinute: z.int().min(0).max(MINUTES_IN_DAY),
  endMinute: z.int().min(0).max(MINUTES_IN_DAY),
});
export type BarberScheduleDto = z.infer<typeof barberScheduleDtoSchema>;

const scheduleRowSchema = z
  .object({
    dayOfWeek: z.int().min(0).max(6),
    startMinute: z.int().min(0).max(MINUTES_IN_DAY),
    endMinute: z.int().min(0).max(MINUTES_IN_DAY),
  })
  .refine((row) => row.endMinute > row.startMinute, {
    error: 'A shift must end after it starts.',
    path: ['endMinute'],
  });

/**
 * The whole week, replaced at once.
 *
 * A barber may have several rows per day — the shop's own barbers all work a morning
 * and an afternoon either side of lunch — so this is a flat list, not one row per day.
 * Overlap within a day is checked server-side; the database's
 * `@@unique([barberId, dayOfWeek, startMinute])` only catches identical start times.
 */
export const replaceBarberScheduleRequestSchema = z.object({
  shifts: z.array(scheduleRowSchema).max(50),
});
export type ReplaceBarberScheduleRequest = z.infer<typeof replaceBarberScheduleRequestSchema>;

// --- Time off ----------------------------------------------------------------

/**
 * What the admin actually chooses. The stored `ScheduleExceptionType` is derived:
 * all-day time off becomes TIME_OFF, a partial range becomes BLOCK, and extra hours
 * becomes EXTRA_HOURS. Both of the first two remove availability identically, so
 * asking which one would be asking for a decision that changes nothing.
 */
export const EXCEPTION_KIND = {
  TIME_OFF: 'TIME_OFF',
  EXTRA_HOURS: 'EXTRA_HOURS',
} as const;
export type ExceptionKind = (typeof EXCEPTION_KIND)[keyof typeof EXCEPTION_KIND];

export const scheduleExceptionDtoSchema = z.object({
  id: z.string(),
  barberId: z.string(),
  kind: z.enum(Object.values(EXCEPTION_KIND) as [string, ...string[]]),
  /** Local dates in the shop's timezone; the UTC instants stay server-side. */
  startDate: z.string(),
  endDate: z.string(),
  allDay: z.boolean(),
  /** Null when all-day. "HH:mm" local. */
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ScheduleExceptionDto = z.infer<typeof scheduleExceptionDtoSchema>;

const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

export const createScheduleExceptionRequestSchema = z
  .object({
    kind: z.enum(Object.values(EXCEPTION_KIND) as [string, ...string[]]),
    startDate: z.string().regex(LOCAL_DATE_PATTERN, { error: 'Use YYYY-MM-DD.' }),
    /** Omitted for a single day. */
    endDate: z.string().regex(LOCAL_DATE_PATTERN, { error: 'Use YYYY-MM-DD.' }).optional(),
    allDay: z.boolean().default(true),
    startTime: z.string().regex(TIME_PATTERN, { error: 'Use HH:mm.' }).optional(),
    endTime: z.string().regex(TIME_PATTERN, { error: 'Use HH:mm.' }).optional(),
    reason: z.string().trim().max(120).nullish(),
  })
  .refine((value) => value.endDate === undefined || value.endDate >= value.startDate, {
    error: 'The end date cannot be before the start date.',
    path: ['endDate'],
  })
  .refine((value) => value.allDay || (value.startTime !== undefined && value.endTime !== undefined), {
    error: 'Give a start and end time, or mark it all day.',
    path: ['startTime'],
  })
  .refine(
    (value) =>
      value.allDay ||
      value.startTime === undefined ||
      value.endTime === undefined ||
      value.endTime > value.startTime,
    { error: 'The end time must be after the start time.', path: ['endTime'] },
  )
  // Extra hours for a whole day says nothing useful — it is the times that matter.
  .refine((value) => value.kind !== EXCEPTION_KIND.EXTRA_HOURS || !value.allDay, {
    error: 'Extra hours need a start and end time.',
    path: ['allDay'],
  });
export type CreateScheduleExceptionRequest = z.infer<typeof createScheduleExceptionRequestSchema>;
