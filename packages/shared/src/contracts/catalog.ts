/**
 * DTOs for the service menu and the barber roster.
 *
 * These are the shapes that cross the wire. Prisma models never do — the server
 * maps to these, and that mapping is what keeps `passwordHash`, `stripeAccountId`,
 * and client phone numbers out of a response by accident rather than by vigilance.
 *
 * Note the deliberate split between the public and staff barber DTOs. The public
 * one is served unauthenticated on the booking site, so it carries no Stripe fields
 * and no email.
 */

import { z } from 'zod';

import { BARBER_STATUS } from '../enums.js';
import { formatDuration } from '../duration.js';
import { LOCAL_DATE_PATTERN, MINUTES_IN_DAY } from '../time.js';

/** A haircut is not an eight-hour job; the cap catches a stray extra digit. */
const MAX_SERVICE_MINUTES = 480;
/** $10,000 for a haircut is a typo, not a price. */
const MAX_SERVICE_CENTS = 1_000_000;

export const serviceDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  /** Integer cents, always. Format with `formatCents`. */
  priceCents: z.int().nonnegative(),
  durationMinutes: z.int().positive(),
  isActive: z.boolean(),
  sortOrder: z.int(),
  bookableOnline: z.boolean(),
  bookableWalkIn: z.boolean(),
});
export type ServiceDto = z.infer<typeof serviceDtoSchema>;

/** Safe for the unauthenticated booking site and the kiosk. */
export const barberPublicDtoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  slug: z.string(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  sortOrder: z.int(),
  acceptsOnline: z.boolean(),
  acceptsWalkIns: z.boolean(),
  /** Ids only — the full service objects are fetched once, separately. */
  serviceIds: z.array(z.string()),
});
export type BarberPublicDto = z.infer<typeof barberPublicDtoSchema>;

/** Staff-only. Adds account state the shop needs but the public must not see. */
export const barberStaffDtoSchema = barberPublicDtoSchema.extend({
  status: z.enum(Object.values(BARBER_STATUS) as [string, ...string[]]),
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  /**
   * Whether Stripe onboarding is finished — deliberately a boolean, not the
   * account id. Nothing outside the payments module needs the id itself.
   */
  stripeConnected: z.boolean(),
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  instantPayoutEligible: z.boolean(),
});
export type BarberStaffDto = z.infer<typeof barberStaffDtoSchema>;

export const shopHoursDtoSchema = z.object({
  dayOfWeek: z.int().min(0).max(6),
  /** Minutes from local midnight, so DST cannot shift opening time. */
  openMinute: z.int().min(0).max(1440),
  closeMinute: z.int().min(0).max(1440),
  isClosed: z.boolean(),
});
export type ShopHoursDto = z.infer<typeof shopHoursDtoSchema>;

export const shopSettingsDtoSchema = z.object({
  name: z.string(),
  /** IANA zone. Every client-side time render resolves through this. */
  timezone: z.string(),
  phone: z.string().nullable(),
  slotGranularityMinutes: z.int().positive(),
  bookingHorizonDays: z.int().positive(),
  minimumNoticeMinutes: z.int().nonnegative(),
  walkInQueueEnabled: z.boolean(),
  onlineBookingEnabled: z.boolean(),
  /** The phone receptionist's own switch — separate from the two above by design. */
  voiceBookingEnabled: z.boolean(),
  hours: z.array(shopHoursDtoSchema),
});
export type ShopSettingsDto = z.infer<typeof shopSettingsDtoSchema>;

// --- Writes ------------------------------------------------------------------

/**
 * Money crosses the wire as INTEGER CENTS, never dollars.
 *
 * The admin types "45.00"; the form converts with `parseDollarsToCents` before it
 * gets here. Accepting a float would put a rounding decision in the transport layer,
 * which is the last place anyone would look for one.
 */
const priceCentsSchema = z
  .int({ error: 'Enter a price.' })
  .nonnegative({ error: 'A price cannot be negative.' })
  .max(MAX_SERVICE_CENTS, { error: 'That price looks like a typo.' });

const durationMinutesSchema = z
  .int({ error: 'Enter a duration in minutes.' })
  .positive({ error: 'A service must take at least a minute.' })
  .max(MAX_SERVICE_MINUTES, { error: `Keep it under ${formatDuration(MAX_SERVICE_MINUTES)}.` });

export const createServiceRequestSchema = z.object({
  name: z.string().trim().min(1, { error: 'Give the service a name.' }).max(80),
  description: z.string().trim().max(500).nullish(),
  category: z.string().trim().max(40).nullish(),
  priceCents: priceCentsSchema,
  durationMinutes: durationMinutesSchema,
  sortOrder: z.int().min(0).max(999).default(0),
  bookableOnline: z.boolean().default(true),
  bookableWalkIn: z.boolean().default(true),
});
export type CreateServiceRequest = z.infer<typeof createServiceRequestSchema>;

/** Every field optional — a PATCH that only changes the price sends only the price. */
export const updateServiceRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullish(),
  category: z.string().trim().max(40).nullish(),
  priceCents: priceCentsSchema.optional(),
  durationMinutes: durationMinutesSchema.optional(),
  sortOrder: z.int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
  bookableOnline: z.boolean().optional(),
  bookableWalkIn: z.boolean().optional(),
});
export type UpdateServiceRequest = z.infer<typeof updateServiceRequestSchema>;

/** The full set, not a delta — the server replaces the assignments wholesale. */
export const setServiceBarbersRequestSchema = z.object({
  barberIds: z.array(z.string()),
});
export type SetServiceBarbersRequest = z.infer<typeof setServiceBarbersRequestSchema>;

export const updateShopSettingsRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** IANA zone name. Validated against the runtime's own zone list server-side. */
  timezone: z.string().trim().min(1).optional(),
  phone: z.string().trim().max(30).nullish(),
  slotGranularityMinutes: z.int().min(5).max(120).optional(),
  bookingHorizonDays: z.int().min(1).max(365).optional(),
  minimumNoticeMinutes: z.int().min(0).max(MINUTES_IN_DAY * 7).optional(),
  walkInQueueEnabled: z.boolean().optional(),
  onlineBookingEnabled: z.boolean().optional(),
  voiceBookingEnabled: z.boolean().optional(),
});
export type UpdateShopSettingsRequest = z.infer<typeof updateShopSettingsRequestSchema>;

const shopHoursRowSchema = z
  .object({
    dayOfWeek: z.int().min(0).max(6),
    /** Minutes from LOCAL midnight, so DST cannot shift opening time. */
    openMinute: z.int().min(0).max(MINUTES_IN_DAY),
    closeMinute: z.int().min(0).max(MINUTES_IN_DAY),
    isClosed: z.boolean(),
  })
  .refine((row) => row.isClosed || row.closeMinute > row.openMinute, {
    error: 'Closing time must be after opening time.',
    path: ['closeMinute'],
  });

/**
 * The whole week at once, not one day at a time.
 *
 * Applied in a single transaction, so there is no window where the shop is half
 * open — and no way to leave a day silently missing.
 */
export const replaceShopHoursRequestSchema = z.object({
  hours: z.array(shopHoursRowSchema).length(7, { error: 'Send all seven days.' }),
});
export type ReplaceShopHoursRequest = z.infer<typeof replaceShopHoursRequestSchema>;

export const shopClosureDtoSchema = z.object({
  id: z.string(),
  /** Local calendar dates in the shop's timezone — the UTC instants stay server-side. */
  startDate: z.string(),
  endDate: z.string(),
  reason: z.string().nullable(),
});
export type ShopClosureDto = z.infer<typeof shopClosureDtoSchema>;

/**
 * Dates, not instants.
 *
 * "Closed on Christmas Day" is a statement about the shop's calendar, not about UTC.
 * The server resolves these against `ShopSettings.timezone`, which keeps timezone
 * arithmetic in exactly one place instead of in every client.
 */
export const createClosureRequestSchema = z
  .object({
    startDate: z.string().regex(LOCAL_DATE_PATTERN, { error: 'Use YYYY-MM-DD.' }),
    endDate: z.string().regex(LOCAL_DATE_PATTERN, { error: 'Use YYYY-MM-DD.' }),
    reason: z.string().trim().max(120).nullish(),
  })
  .refine((value) => value.endDate >= value.startDate, {
    error: 'The end date cannot be before the start date.',
    path: ['endDate'],
  });
export type CreateClosureRequest = z.infer<typeof createClosureRequestSchema>;
