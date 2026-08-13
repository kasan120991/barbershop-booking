/**
 * Availability and appointment contracts.
 *
 * Note what is absent from every request shape: price and duration. Both are computed
 * server-side from `Service` rows. A caller that could name its own price could book
 * a free haircut; one that could name its own duration could fit an hour into a
 * fifteen-minute gap.
 */

import { z } from 'zod';

import { APPOINTMENT_SOURCE, APPOINTMENT_STATUS } from '../enums.js';
import { LOCAL_DATE_PATTERN } from '../time.js';

export const availabilityQuerySchema = z.object({
  barberId: z.string().min(1),
  /** Local date in the shop's zone. */
  date: z.string().regex(LOCAL_DATE_PATTERN, { error: 'Use YYYY-MM-DD.' }),
  serviceIds: z.array(z.string().min(1)).min(1, { error: 'Choose at least one service.' }),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const availabilityResponseSchema = z.object({
  barberId: z.string(),
  date: z.string(),
  durationMinutes: z.int(),
  /** UTC instants. The client renders them in the shop's timezone. */
  slots: z.array(z.iso.datetime()),
  /** Present only when there are no slots, so the UI can say why rather than "none". */
  reason: z.string().nullable(),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

export const createAppointmentRequestSchema = z.object({
  barberId: z.string().min(1),
  serviceIds: z.array(z.string().min(1)).min(1, { error: 'Choose at least one service.' }),
  /** A slot returned by the availability endpoint. */
  startAt: z.iso.datetime(),
  /** Unverified, and the client's identity — normalised server-side. */
  phone: z.string().min(1, { error: 'Enter a phone number.' }),
  firstName: z.string().trim().min(1, { error: 'Enter a first name.' }).max(60),
  lastName: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(500).nullish(),
});
export type CreateAppointmentRequest = z.infer<typeof createAppointmentRequestSchema>;

export const appointmentServiceDtoSchema = z.object({
  serviceId: z.string(),
  /** The name AS BOOKED — a later rename of the service does not change this. */
  name: z.string(),
  priceCents: z.int(),
  durationMinutes: z.int(),
});
export type AppointmentServiceDto = z.infer<typeof appointmentServiceDtoSchema>;

export const appointmentDtoSchema = z.object({
  id: z.string(),
  barberId: z.string(),
  barberName: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  /**
   * When the client ACTUALLY sat down, or null if they have not.
   *
   * Distinct from `startAt`, which is when they were due — and the two diverge constantly.
   * A progress bar or a finish time drawn from `startAt` describes the timetable rather
   * than the cut: a client seated three hours early leaves the bar at zero and the "done"
   * time hours out, which is exactly the bug this field was added for.
   */
  startedAt: z.iso.datetime().nullable(),
  durationMinutes: z.int(),
  priceCentsTotal: z.int(),
  status: z.enum(Object.values(APPOINTMENT_STATUS) as [string, ...string[]]),
  source: z.enum(Object.values(APPOINTMENT_SOURCE) as [string, ...string[]]),
  notes: z.string().nullable(),
  services: z.array(appointmentServiceDtoSchema),
});
export type AppointmentDto = z.infer<typeof appointmentDtoSchema>;

/**
 * What a client gets back after booking online.
 *
 * Carries the cancellation token, which is the only time it is handed out — the
 * link is the credential, so appointment ids stay unguessable.
 */
export const bookingConfirmationDtoSchema = z.object({
  appointmentId: z.string(),
  cancelToken: z.string(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  barberName: z.string(),
  priceCentsTotal: z.int(),
  services: z.array(appointmentServiceDtoSchema),
});
export type BookingConfirmationDto = z.infer<typeof bookingConfirmationDtoSchema>;

export const updateAppointmentStatusRequestSchema = z.object({
  status: z.enum(Object.values(APPOINTMENT_STATUS) as [string, ...string[]]),
});
export type UpdateAppointmentStatusRequest = z.infer<typeof updateAppointmentStatusRequestSchema>;

/**
 * Moving an appointment.
 *
 * `serviceIds` is absent on purpose in the common case: a move is not a repricing, and
 * omitting them keeps the snapshotted price and duration the booking was made at. Supply
 * them only when the basket itself is genuinely changing.
 */
export const rescheduleAppointmentRequestSchema = z.object({
  /** A slot returned by the availability endpoint. */
  startAt: z.iso.datetime(),
  /** Omitted keeps the current barber. */
  barberId: z.string().min(1).nullish(),
  serviceIds: z.array(z.string().min(1)).min(1).nullish(),
});
export type RescheduleAppointmentRequest = z.infer<typeof rescheduleAppointmentRequestSchema>;

export const cancelAppointmentRequestSchema = z.object({
  reason: z.string().trim().max(200).nullish(),
});
export type CancelAppointmentRequest = z.infer<typeof cancelAppointmentRequestSchema>;
