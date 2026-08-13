/**
 * Appointment DTO mappers.
 *
 * Same rule as every other mapper: fields listed explicitly, never a spread of a
 * Prisma model. Two things here would be actively harmful if forwarded by accident —
 * the client's **phone number**, which is their identity and appears on shop-floor
 * screens, and the **cancel token**, which is a bearer credential.
 *
 * The token appears in exactly one DTO, `toBookingConfirmationDto`, returned once to
 * the person who just booked. Nothing that lists appointments carries it.
 */

import { publicDisplayName, type AppointmentDto, type BookingConfirmationDto } from '@francis/shared';

import type {
  AppointmentModel,
  AppointmentServiceModel,
  BarberModel,
  ClientModel,
} from '../generated/prisma/models.js';

type AppointmentWithRelations = AppointmentModel & {
  services: AppointmentServiceModel[];
  client: ClientModel;
  barber: BarberModel;
};

export function toAppointmentDto(appointment: AppointmentWithRelations): AppointmentDto {
  return {
    id: appointment.id,
    barberId: appointment.barberId,
    barberName: appointment.barber.displayName,
    clientId: appointment.clientId,
    // First name plus last initial, even for staff. Nothing needs the full name to
    // run a day, and this is the string most likely to end up on a shared screen.
    clientName: publicDisplayName(appointment.client.firstName, appointment.client.lastName),
    startAt: appointment.startAt.toISOString(),
    endAt: appointment.endAt.toISOString(),
    startedAt: appointment.startedAt?.toISOString() ?? null,
    durationMinutes: appointment.durationMinutes,
    priceCentsTotal: appointment.priceCentsTotal,
    status: appointment.status,
    source: appointment.source,
    notes: appointment.notes,
    services: appointment.services.map((service) => ({
      serviceId: service.serviceId,
      // The snapshot, not the live menu name.
      name: service.nameSnapshot,
      priceCents: service.priceCents,
      durationMinutes: service.durationMinutes,
    })),
  };
}

/**
 * The one DTO that carries the cancel token.
 *
 * Returned only to whoever just made the booking, because the token is what lets
 * them cancel without an account — appointment ids are never a way in.
 */
export function toBookingConfirmationDto(
  appointment: AppointmentWithRelations,
): BookingConfirmationDto {
  return {
    appointmentId: appointment.id,
    cancelToken: appointment.cancelToken,
    startAt: appointment.startAt.toISOString(),
    endAt: appointment.endAt.toISOString(),
    barberName: appointment.barber.displayName,
    priceCentsTotal: appointment.priceCentsTotal,
    services: appointment.services.map((service) => ({
      serviceId: service.serviceId,
      name: service.nameSnapshot,
      priceCents: service.priceCents,
      durationMinutes: service.durationMinutes,
    })),
  };
}
