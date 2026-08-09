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
  hours: z.array(shopHoursDtoSchema),
});
export type ShopSettingsDto = z.infer<typeof shopSettingsDtoSchema>;
