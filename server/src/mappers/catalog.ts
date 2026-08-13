/**
 * Prisma model -> DTO mappers.
 *
 * This is the boundary the architecture depends on. Every field that reaches a
 * frontend is listed here explicitly — there is no spread of a Prisma model into a
 * response anywhere in the codebase, because a spread silently forwards whatever
 * column gets added to the schema next.
 *
 * `toBarberPublicDto` in particular must never grow a Stripe field or an email.
 */

import type {
  BarberPublicDto,
  BarberStaffDto,
  ServiceDto,
  ShopSettingsDto,
} from '@francis/shared';

// Prisma 7 names the row types `<Model>Model`; the bare name is the delegate.
import type {
  BarberModel,
  ServiceModel,
  ShopHoursModel,
  ShopSettingsModel,
  UserModel,
} from '../generated/prisma/models.js';

export function toServiceDto(service: ServiceModel): ServiceDto {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    category: service.category,
    priceCents: service.priceCents,
    durationMinutes: service.durationMinutes,
    isActive: service.isActive,
    sortOrder: service.sortOrder,
    bookableOnline: service.bookableOnline,
    bookableWalkIn: service.bookableWalkIn,
  };
}

export function toBarberPublicDto(barber: BarberModel, serviceIds: string[]): BarberPublicDto {
  return {
    id: barber.id,
    displayName: barber.displayName,
    slug: barber.slug,
    bio: barber.bio,
    avatarUrl: barber.avatarUrl,
    sortOrder: barber.sortOrder,
    acceptsOnline: barber.acceptsOnline,
    acceptsWalkIns: barber.acceptsWalkIns,
    serviceIds,
  };
}

export function toBarberStaffDto(
  barber: BarberModel,
  user: Pick<UserModel, 'email' | 'firstName' | 'lastName'>,
  serviceIds: string[],
): BarberStaffDto {
  return {
    ...toBarberPublicDto(barber, serviceIds),
    status: barber.status,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    // The account id itself never leaves the payments module — only whether it exists.
    stripeConnected: barber.stripeAccountId !== null,
    chargesEnabled: barber.chargesEnabled,
    payoutsEnabled: barber.payoutsEnabled,
    instantPayoutEligible: barber.instantPayoutEligible,
  };
}

export function toShopSettingsDto(settings: ShopSettingsModel, hours: ShopHoursModel[]): ShopSettingsDto {
  return {
    name: settings.name,
    timezone: settings.timezone,
    phone: settings.phone,
    slotGranularityMinutes: settings.slotGranularityMinutes,
    bookingHorizonDays: settings.bookingHorizonDays,
    minimumNoticeMinutes: settings.minimumNoticeMinutes,
    walkInQueueEnabled: settings.walkInQueueEnabled,
    onlineBookingEnabled: settings.onlineBookingEnabled,
    voiceBookingEnabled: settings.voiceBookingEnabled,
    hours: hours
      .slice()
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.openMinute - b.openMinute)
      .map((row) => ({
        dayOfWeek: row.dayOfWeek,
        openMinute: row.openMinute,
        closeMinute: row.closeMinute,
        isClosed: row.isClosed,
      })),
  };
}
