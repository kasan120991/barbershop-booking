/**
 * Booking — the one operation in this system with a genuine race.
 *
 * Two people can ask for the same 10:00 slot in the same millisecond. Checking
 * availability and then inserting is not enough: both checks pass, both insert, and
 * two clients turn up for one chair. MySQL cannot express "no overlapping ranges" as
 * a constraint, so the exclusion has to be taken explicitly.
 *
 * Every path that creates an appointment goes through `createAppointment` — online,
 * kiosk, staff, and later the Vapi receptionist. There is deliberately no second way
 * to write one.
 */

import { normalizePhone, type AppointmentSource } from '@francis/shared';
import { DateTime } from 'luxon';

import type { AppointmentStatus } from '../generated/prisma/enums.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export interface CreateAppointmentInput {
  barberId: string;
  serviceIds: string[];
  /** UTC instant of the requested start. */
  startAt: Date;
  client: { phone: string; firstName: string; lastName?: string | null | undefined };
  source: AppointmentSource;
  notes?: string | null;
  createdByUserId?: string | null;
  /** Staff may book inside the notice window; the public may not. */
  enforceMinimumNotice: boolean;
  now?: Date;
}

/** Statuses that still occupy the chair. Cancelled and no-show free it. */
const BLOCKING: AppointmentStatus[] = ['BOOKED', 'IN_PROGRESS'];

export async function createAppointment(input: CreateAppointmentInput) {
  const now = input.now ?? new Date();

  const settings = await prisma.shopSettings.findUnique({ where: { id: 1 } });
  if (!settings) throw new NotFoundError('Shop settings have not been set up.');

  const barber = await prisma.barber.findUnique({ where: { id: input.barberId } });
  if (!barber) throw new NotFoundError('Barber not found.');
  if (barber.status !== 'ACTIVE') throw new ValidationError('That barber is not taking bookings.');

  if (input.serviceIds.length === 0) throw new ValidationError('Choose at least one service.');

  const services = await prisma.service.findMany({ where: { id: { in: input.serviceIds } } });
  if (services.length !== new Set(input.serviceIds).size) {
    throw new ValidationError('One of those services no longer exists.');
  }
  const inactive = services.find((service) => !service.isActive);
  if (inactive) throw new ValidationError(`${inactive.name} is no longer offered.`);

  /**
   * Duration and price are computed HERE from the Service rows, never taken from the
   * request. A caller that could name its own price could book a $0 haircut, and one
   * that could name its own duration could fit an hour-long cut into a 15-minute gap.
   */
  const durationMinutes = services.reduce((total, service) => total + service.durationMinutes, 0);
  const priceCentsTotal = services.reduce((total, service) => total + service.priceCents, 0);
  if (durationMinutes <= 0) throw new ValidationError('That service has no duration.');

  const startAt = input.startAt;
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);

  if (startAt.getTime() <= now.getTime()) {
    throw new ValidationError('That time has already passed.');
  }
  if (input.enforceMinimumNotice) {
    const earliest = now.getTime() + settings.minimumNoticeMinutes * 60_000;
    if (startAt.getTime() < earliest) {
      throw new ValidationError(
        `Bookings need at least ${String(settings.minimumNoticeMinutes)} minutes' notice.`,
      );
    }
  }

  // The phone number IS the client identity, so it is normalised before lookup —
  // "(415) 555-0123" and "+14155550123" must not become two people.
  const phoneE164 = normalizePhone(input.client.phone);
  if (!phoneE164) throw new ValidationError('That phone number does not look right.');

  const client = await prisma.client.upsert({
    where: { phoneE164 },
    update: {},
    create: {
      phoneE164,
      firstName: input.client.firstName.trim(),
      lastName: input.client.lastName?.trim() || null,
    },
  });
  if (client.isBlocked) throw new ValidationError('That number cannot book online.');

  /** Local shop date, which is what the lock is keyed on. */
  const day = DateTime.fromJSDate(startAt).setZone(settings.timezone).toFormat('yyyy-MM-dd');
  const bufferMs = settings.bufferMinutes * 60_000;

  /**
   * An INTERACTIVE transaction, so every statement below runs on one connection —
   * `FOR UPDATE` only holds a lock for the duration of the transaction that took it,
   * and Prisma's array form would spread these across connections.
   */
  return prisma.$transaction(async (tx) => {
    // The lock row has to exist before it can be locked, and creating it must not
    // race either. INSERT IGNORE is a no-op when another request got there first.
    await tx.$executeRaw`
      INSERT IGNORE INTO barber_day_locks (barberId, day) VALUES (${input.barberId}, ${day})
    `;

    // Serializes every booking for this barber on this day. A second request waits
    // here until the first commits, and then sees its appointment.
    await tx.$queryRaw`
      SELECT barberId FROM barber_day_locks
      WHERE barberId = ${input.barberId} AND day = ${day}
      FOR UPDATE
    `;

    // Re-checked INSIDE the lock. Whatever availability said a moment ago, this is
    // the answer that counts. The buffer applies on both sides: a new appointment
    // must not start within the turnaround of an existing one, or vice versa.
    const conflict = await tx.appointment.findFirst({
      where: {
        barberId: input.barberId,
        status: { in: BLOCKING },
        startAt: { lt: new Date(endAt.getTime() + bufferMs) },
        endAt: { gt: new Date(startAt.getTime() - bufferMs) },
      },
      select: { id: true, startAt: true },
    });

    if (conflict) {
      throw new ConflictError('Someone just took that time. Please pick another.');
    }

    return tx.appointment.create({
      data: {
        clientId: client.id,
        barberId: input.barberId,
        startAt,
        endAt,
        durationMinutes,
        priceCentsTotal,
        source: input.source,
        notes: input.notes ?? null,
        createdByUserId: input.createdByUserId ?? null,
        services: {
          create: services.map((service) => ({
            serviceId: service.id,
            // Snapshotted, so editing the menu later never rewrites this booking.
            priceCents: service.priceCents,
            durationMinutes: service.durationMinutes,
            nameSnapshot: service.name,
          })),
        },
      },
      include: { services: true, client: true, barber: true },
    });
  });
}

// --- Reads -------------------------------------------------------------------

export function getAppointment(appointmentId: string) {
  return prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { services: true, client: true, barber: true },
  });
}

export function listAppointments(filters: { from: Date; to: Date; barberId?: string }) {
  return prisma.appointment.findMany({
    where: {
      startAt: { gte: filters.from, lt: filters.to },
      ...(filters.barberId === undefined ? {} : { barberId: filters.barberId }),
    },
    orderBy: { startAt: 'asc' },
    include: { services: true, client: true, barber: true },
  });
}

// --- Cancellation ------------------------------------------------------------

export interface CancelOptions {
  reason?: string | null;
  /** Public cancellation respects the notice window; staff cancellation does not. */
  enforceMinimumNotice: boolean;
  now?: Date;
}

async function cancel(
  appointment: { id: string; startAt: Date; status: AppointmentStatus },
  options: CancelOptions,
) {
  if (appointment.status === 'CANCELLED') {
    throw new ConflictError('That appointment is already cancelled.');
  }
  if (appointment.status === 'COMPLETED') {
    throw new ConflictError('That appointment has already happened.');
  }

  const now = options.now ?? new Date();

  if (options.enforceMinimumNotice) {
    const settings = await prisma.shopSettings.findUnique({ where: { id: 1 } });
    const notice = (settings?.minimumNoticeMinutes ?? 0) * 60_000;
    if (appointment.startAt.getTime() - now.getTime() < notice) {
      throw new ConflictError(
        'It is too close to your appointment to cancel online. Please call the shop.',
      );
    }
  }

  return prisma.appointment.update({
    where: { id: appointment.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: now,
      cancelReason: options.reason ?? null,
    },
  });
}

/** Staff cancellation, by id. */
export async function cancelAppointment(appointmentId: string, options: CancelOptions) {
  const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appointment) throw new NotFoundError('Appointment not found.');
  return cancel(appointment, options);
}

/**
 * Public cancellation, by opaque token.
 *
 * The token exists so a cancellation link cannot be guessed by walking ids. A wrong
 * token is a plain 404 — it must not reveal whether an appointment exists.
 */
export async function cancelAppointmentByToken(token: string, options: CancelOptions) {
  const appointment = await prisma.appointment.findUnique({ where: { cancelToken: token } });
  if (!appointment) throw new NotFoundError('That link is not valid.');
  return cancel(appointment, options);
}

// --- Status ------------------------------------------------------------------

/** Only the moves that make sense; anything else is refused rather than stored. */
const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  BOOKED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export async function updateAppointmentStatus(appointmentId: string, next: AppointmentStatus) {
  const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appointment) throw new NotFoundError('Appointment not found.');

  if (!ALLOWED_TRANSITIONS[appointment.status].includes(next)) {
    throw new ConflictError(
      `An appointment that is ${appointment.status.toLowerCase()} cannot become ${next.toLowerCase()}.`,
    );
  }

  return prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      status: next,
      ...(next === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
    },
  });
}
