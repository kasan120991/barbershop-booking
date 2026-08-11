/**
 * Availability and appointments.
 *
 * The public surface here is the first unauthenticated *write* in the system, so it
 * is the first place rate limiting matters. Booking is limited by IP **and** by phone
 * number: an IP limit alone is defeated by a botnet, and a phone limit alone by
 * cycling numbers. Both, per the standing rule.
 */

import {
  availabilityQuerySchema,
  cancelAppointmentRequestSchema,
  createAppointmentRequestSchema,
  ROLE,
  updateAppointmentStatusRequestSchema,
  normalizePhone,
  type AvailabilityResponse,
  type BookingConfirmationDto,
} from '@francis/shared';
import { Router } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import type { AppointmentStatus, Role } from '../generated/prisma/enums.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { limiter } from '../lib/rate-limit.js';
import { pathParam } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { toAppointmentDto, toBookingConfirmationDto } from '../mappers/appointment.js';
import {
  assertBarberSelfOrAdmin,
  requireRole,
  requireUser,
} from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import { getAvailability } from '../services/availability.js';
import {
  cancelAppointment,
  cancelAppointmentByToken,
  createAppointment,
  getAppointment,
  getAppointmentByToken,
  getAppointmentOwner,
  listAppointments,
  updateAppointmentStatus,
} from '../services/booking.js';

export const bookingRouter: Router = Router();

const adminOnly = requireRole(ROLE.ADMIN as Role);

/** Per-IP: stops one host hammering the booking form. */
const bookingIpLimit = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: 'Too many bookings from here just now. Please try again later, or call the shop.',
});

/**
 * Per-phone: stops a distributed attempt to fill one barber's day, which an IP limit
 * cannot see. Keyed on the normalised number so formatting variations are one key.
 */
const bookingPhoneLimit = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: 'That number has made several bookings already. Please call the shop.',
  keyGenerator: (req) => {
    const body = req.body as { phone?: unknown };
    const phone = typeof body?.phone === 'string' ? normalizePhone(body.phone) : null;
    // Falls back to IP when there is no usable number; validation rejects it anyway.
    // Normalised through `ipKeyGenerator` so an IPv6 client cannot get a fresh bucket
    // per address in a prefix it owns outright.
    return phone ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
});

// --- Availability ------------------------------------------------------------

/** Public: the booking site needs this before anyone has identified themselves. */
bookingRouter.get('/availability', async (req, res) => {
  const raw = req.query as Record<string, unknown>;
  const serviceIds =
    typeof raw.serviceIds === 'string'
      ? raw.serviceIds.split(',').filter(Boolean)
      : Array.isArray(raw.serviceIds)
        ? (raw.serviceIds as string[])
        : [];

  const query = availabilityQuerySchema.parse({
    barberId: raw.barberId,
    date: raw.date,
    serviceIds,
  });

  const [result, durationMinutes] = await Promise.all([
    getAvailability(query),
    totalDuration(query.serviceIds),
  ]);

  const body: AvailabilityResponse = {
    barberId: query.barberId,
    date: query.date,
    // Echoed back from the Service rows, so the UI can say "60 min" without the
    // caller having told us what it thinks the duration is.
    durationMinutes,
    slots: result.slots.map((slot) => slot.toISOString()),
    reason: result.reason,
  };

  res.json(body);
});

// --- Booking -----------------------------------------------------------------

/**
 * Public booking. Staff use the same route while signed in, which relaxes the notice
 * window and records who took it — one code path, one lock, no second way to write
 * an appointment.
 */
bookingRouter.post('/appointments', bookingIpLimit, bookingPhoneLimit, async (req, res) => {
  const input = createAppointmentRequestSchema.parse(req.body);
  const isStaff = req.auth?.kind === 'user';

  const startAt = new Date(input.startAt);
  if (Number.isNaN(startAt.getTime())) throw new ValidationError('That start time is not valid.');

  const appointment = await createAppointment({
    barberId: input.barberId,
    serviceIds: input.serviceIds,
    startAt,
    client: { phone: input.phone, firstName: input.firstName, lastName: input.lastName },
    source: isStaff ? 'STAFF' : 'ONLINE',
    notes: input.notes ?? null,
    createdByUserId: isStaff && req.auth?.kind === 'user' ? req.auth.userId : null,
    // Staff can fit someone in at short notice; the public cannot.
    enforceMinimumNotice: !isStaff,
    // And the shop's online switches govern the public only — turning online booking
    // off must not stop the desk taking one over the counter.
    enforceOnlineRules: !isStaff,
  });

  await recordAudit(auditContext(req), {
    action: 'appointment.created',
    entityType: 'Appointment',
    entityId: appointment.id,
    after: {
      barberId: appointment.barberId,
      startAt: appointment.startAt,
      priceCentsTotal: appointment.priceCentsTotal,
    },
  });

  const body: BookingConfirmationDto = toBookingConfirmationDto(appointment);
  res.status(201).json({ booking: body });
});

// --- Staff reads and lifecycle ----------------------------------------------

bookingRouter.get('/appointments', requireUser, async (req, res) => {
  const raw = req.query as Record<string, unknown>;
  const from = typeof raw.from === 'string' ? new Date(raw.from) : null;
  const to = typeof raw.to === 'string' ? new Date(raw.to) : null;

  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ValidationError('Give a from and to date.');
  }

  // A barber sees only their own book unless they are also an admin.
  const barberId =
    req.auth?.kind === 'user' && !req.auth.roles.includes('ADMIN' as Role)
      ? (req.auth.barberId ?? undefined)
      : typeof raw.barberId === 'string'
        ? raw.barberId
        : undefined;

  const appointments = await listAppointments({
    from,
    to,
    ...(barberId === undefined ? {} : { barberId }),
  });

  res.json({ appointments: appointments.map(toAppointmentDto) });
});

/**
 * Staff cancellation.
 *
 * `requireUser` alone was not enough: it proved somebody was signed in and nothing about
 * whose book they were reaching into, so any barber could cancel any other barber's
 * appointment by id. The read above it has always scoped a barber to their own book —
 * this half was missed. Same rule, both directions now.
 */
bookingRouter.post('/appointments/:appointmentId/cancel', requireUser, async (req, res) => {
  const appointmentId = pathParam(req, 'appointmentId');
  const { reason } = cancelAppointmentRequestSchema.parse(req.body ?? {});

  // Whose chair this is, before deciding whether the caller may touch it.
  assertBarberSelfOrAdmin(req, await getAppointmentOwner(appointmentId));

  const before = await getAppointment(appointmentId);
  // Staff are not held to the notice window — they are standing in the shop.
  const cancelled = await cancelAppointment(appointmentId, {
    reason: reason ?? null,
    enforceMinimumNotice: false,
  });

  await recordAudit(auditContext(req), {
    action: 'appointment.cancelled',
    entityType: 'Appointment',
    entityId: appointmentId,
    before: { status: before?.status },
    after: { status: cancelled.status, reason: cancelled.cancelReason },
  });

  res.json({ appointment: toAppointmentDto(await requireLoaded(appointmentId)) });
});

/** Self-or-admin for the same reason as the cancel above. */
bookingRouter.patch('/appointments/:appointmentId/status', requireUser, async (req, res) => {
  const appointmentId = pathParam(req, 'appointmentId');
  const { status } = updateAppointmentStatusRequestSchema.parse(req.body);

  assertBarberSelfOrAdmin(req, await getAppointmentOwner(appointmentId));

  const before = await getAppointment(appointmentId);
  await updateAppointmentStatus(appointmentId, status as AppointmentStatus);

  await recordAudit(auditContext(req), {
    action: 'appointment.status_changed',
    entityType: 'Appointment',
    entityId: appointmentId,
    before: { status: before?.status },
    after: { status },
  });

  res.json({ appointment: toAppointmentDto(await requireLoaded(appointmentId)) });
});

// --- Public cancellation -----------------------------------------------------

/**
 * The read half of the cancel link.
 *
 * Without it a bookmarked cancel page could only ask "cancel your appointment?" with
 * no idea which one — the token was write-only, and there was no way to look up what it
 * referred to. Same bearer-token model as the cancel below, same opaque 404, and it
 * returns exactly what the booking confirmation returned: no client name, no phone, no
 * notes, nothing the holder of the link did not already type in themselves.
 */
bookingRouter.get('/appointments/token/:token', async (req, res) => {
  const appointment = await getAppointmentByToken(pathParam(req, 'token'));
  if (!appointment) throw new NotFoundError('That link is not valid.');

  const body: BookingConfirmationDto = toBookingConfirmationDto(appointment);
  res.json({ booking: body, status: appointment.status });
});

/**
 * By opaque token, never by id.
 *
 * The token IS the credential, which is why appointment ids are never guessable
 * entry points. A wrong token is a plain 404 that reveals nothing about whether an
 * appointment exists.
 */
bookingRouter.post('/appointments/cancel/:token', async (req, res) => {
  const token = pathParam(req, 'token');
  const cancelled = await cancelAppointmentByToken(token, { enforceMinimumNotice: true });

  await recordAudit(auditContext(req), {
    action: 'appointment.cancelled',
    entityType: 'Appointment',
    entityId: cancelled.id,
    after: { status: cancelled.status, via: 'token' },
  });

  res.status(204).send();
});

/** Admin-only sweep of everything, for the reporting phase later. */
bookingRouter.get('/appointments/:appointmentId', adminOnly, async (req, res) => {
  res.json({ appointment: toAppointmentDto(await requireLoaded(pathParam(req, 'appointmentId'))) });
});

async function requireLoaded(appointmentId: string) {
  const appointment = await getAppointment(appointmentId);
  if (!appointment) throw new ValidationError('Appointment not found.');
  return appointment;
}

/** Sum of the requested services, for echoing the duration back with the slots. */
async function totalDuration(serviceIds: string[]): Promise<number> {
  const services = await prisma.service.findMany({
    where: { id: { in: serviceIds } },
    select: { durationMinutes: true },
  });
  return services.reduce((total, service) => total + service.durationMinutes, 0);
}
