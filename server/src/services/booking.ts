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

import {
  APPOINTMENT_CHANGE,
  formatDuration,
  type AppointmentChange,
  type AppointmentSource,
} from '@francis/shared';
import { DateTime } from 'luxon';

import { logger } from '../lib/logger.js';

import type { AppointmentStatus } from '../generated/prisma/enums.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { findOrCreateClient } from './clients.js';
import { broadcastAppointmentChanged } from '../realtime/broadcast.js';
import { refreshQueueEstimates } from './queue.js';

/**
 * Recomputes the board, then tells the shop what moved.
 *
 * Both jobs in one function because every appointment mutation already called this one —
 * the alternative is the same two lines in four handlers, where the fourth is the one that
 * gets missed. It is the same argument `refreshQueueEstimates` makes for owning the queue
 * broadcast, applied one level up.
 *
 * The calendar and the walk-in line share one day, so changing either moves the other.
 *
 * Booking an appointment takes time the estimator had already promised to somebody
 * standing in the shop; cancelling one hands it back. Without this, the board keeps
 * quoting a slot that was sold five seconds ago and only corrects itself the next time
 * the queue happens to be touched.
 *
 * Deliberately awaited rather than fired and forgotten: the caller's response should
 * not describe a world the board disagrees with. It also broadcasts, because
 * `refreshQueueEstimates` is the one place that does.
 *
 * `now` is threaded through rather than read from the clock here, for the same reason
 * every other estimate in this codebase takes it: a booking made against an injected
 * clock must recompute against that same clock, or the test asserts on one world and
 * the code answers about another.
 */
async function announceAppointmentChange(
  change: {
    appointmentId: string;
    action: AppointmentChange;
    /** One, or two when a move crosses chairs. Deduped here so callers need not bother. */
    barberIds: readonly string[];
    /** One, or two when a move crosses days. */
    startAts: readonly Date[];
  },
  now: Date,
): Promise<void> {
  try {
    await refreshQueueEstimates(now);
  } catch (error) {
    // A failed recompute must not fail the booking that already committed. The next
    // queue mutation, or the client's fallback poll, will correct it.
    logger.error({ err: error }, 'Failed to recompute queue estimates after an appointment change');
  }

  /**
   * After the recompute, not instead of it — a client reacting to both events then sees a
   * settled world rather than a calendar that has moved and a board that has not.
   *
   * Outside the catch above on purpose: the calendar is still wrong even when the
   * estimator fell over, so the announcement is the one thing that must happen either way.
   */
  broadcastAppointmentChanged({
    appointmentId: change.appointmentId,
    action: change.action,
    barberIds: [...new Set(change.barberIds)],
    startAts: [...new Set(change.startAts.map((at) => at.toISOString()))],
  });
}

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
  /**
   * Whether the shop's *online* switches apply — `onlineBookingEnabled`,
   * `Service.bookableOnline`, `Barber.acceptsOnline`.
   *
   * A separate flag from `enforceMinimumNotice` because they answer different
   * questions, and both are false for staff. Switching off online booking must not
   * stop the person at the desk taking a booking over the counter; that is the whole
   * point of a switch that says *online*.
   */
  enforceOnlineRules: boolean;
  now?: Date;
}

/** Statuses that still occupy the chair. Cancelled and no-show free it. */
const BLOCKING: AppointmentStatus[] = ['BOOKED', 'IN_PROGRESS'];

/** The Prisma handle inside an interactive transaction. */
type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** One row in `barber_day_locks`: one barber, one local shop date. */
interface BarberDayKey {
  barberId: string;
  day: string;
}

/** Local shop date, which is what the lock is keyed on. */
function localShopDay(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at).setZone(timezone).toFormat('yyyy-MM-dd');
}

/** Deduped and sorted — see `lockBarberDays` for why the order matters. */
function orderLockKeys(keys: readonly BarberDayKey[]): BarberDayKey[] {
  return [...new Map(keys.map((key) => [`${key.barberId}|${key.day}`, key])).values()].sort((a, b) =>
    `${a.barberId}|${a.day}`.localeCompare(`${b.barberId}|${b.day}`),
  );
}

/**
 * Creates any missing lock rows, OUTSIDE the transaction that will lock them.
 *
 * This is separated from the locking for one specific reason. `INSERT IGNORE` on a row
 * that already exists still takes a SHARED lock on the duplicate key before deciding to
 * do nothing, and the `SELECT ... FOR UPDATE` that follows then has to upgrade S to X.
 * Two requests touching the same barber-day at the same moment both take S and both wait
 * for the other to release it — InnoDB kills one with "Deadlock found when trying to get
 * lock". Ordering the keys cannot help there, because both transactions are contending
 * on the *same* key.
 *
 * Running the insert on its own, autocommitted, means the S lock is taken and released
 * before the real transaction begins. The transaction then only ever locks a row that
 * already exists, which is a direct X with no upgrade.
 *
 * It also has to stay out of the transaction for a second reason: it must not be a
 * *consistent* read. In REPEATABLE READ, the first non-locking read establishes the
 * transaction's snapshot, and every later non-locking read answers from it — including
 * `assertNoOverlap`. Put a plain `SELECT` before the lock and the overlap check answers
 * from a view of the world taken before the competitor committed, which is how a
 * double-booking gets written by code that looks like it checked.
 */
async function ensureBarberDayLocks(keys: readonly BarberDayKey[]): Promise<void> {
  for (const key of orderLockKeys(keys)) {
    await prisma.$executeRaw`
      INSERT IGNORE INTO barber_day_locks (barberId, day) VALUES (${key.barberId}, ${key.day})
    `;
  }
}

/**
 * Takes the per-barber-per-day exclusion lock for every key given.
 *
 * **Sorted is not cosmetic.** Creating an appointment needs one lock, but moving one
 * across barbers or across days needs two — and two such moves in opposite directions
 * (A's Tuesday to B's Wednesday while B's Wednesday goes to A's Tuesday) can each end up
 * holding what the other is waiting for. A fixed, arbitrary order applied by every caller
 * makes that impossible rather than unlikely — the same reasoning `refreshQueueEstimates`
 * sorts its updates by id for.
 *
 * `createAppointment` passes a single key and so participates in that order trivially.
 * Duplicates collapse, so a move inside one barber's day takes one lock, not two.
 *
 * Every statement here is a LOCKING read. Nothing in this function may be a plain
 * `SELECT` — see `ensureBarberDayLocks` for what that costs.
 */
async function lockBarberDays(tx: TransactionClient, keys: readonly BarberDayKey[]): Promise<void> {
  for (const key of orderLockKeys(keys)) {
    // Serializes every write for this barber on this day. A second request waits here
    // until the first commits, and then sees its appointment.
    await tx.$queryRaw`
      SELECT barberId FROM barber_day_locks
      WHERE barberId = ${key.barberId} AND day = ${key.day}
      FOR UPDATE
    `;
  }
}

/**
 * Turns a set of service ids into rows, a duration and a price.
 *
 * **Duration and price are computed HERE from the `Service` rows, never taken from the
 * request.** A caller that could name its own price could book a $0 haircut, and one
 * that could name its own duration could fit an hour-long cut into a fifteen-minute gap.
 *
 * Shared by `createAppointment` and by a reschedule that genuinely changes the basket,
 * so the two cannot drift on which services a booking may contain.
 */
async function resolveServicesForBooking(serviceIds: readonly string[], enforceOnlineRules: boolean) {
  if (serviceIds.length === 0) throw new ValidationError('Choose at least one service.');

  const services = await prisma.service.findMany({ where: { id: { in: [...serviceIds] } } });
  if (services.length !== new Set(serviceIds).size) {
    throw new ValidationError('One of those services no longer exists.');
  }

  const inactive = services.find((service) => !service.isActive);
  if (inactive) throw new ValidationError(`${inactive.name} is no longer offered.`);

  // Separate from `isActive` on purpose: the shop can keep offering a two-hour colour
  // at the desk while refusing to let a stranger book one unattended.
  const notOnline = enforceOnlineRules
    ? services.find((service) => !service.bookableOnline)
    : undefined;
  if (notOnline) throw new ValidationError(`${notOnline.name} has to be booked by phone.`);

  const durationMinutes = services.reduce((total, service) => total + service.durationMinutes, 0);
  const priceCentsTotal = services.reduce((total, service) => total + service.priceCents, 0);
  if (durationMinutes <= 0) throw new ValidationError('That service has no duration.');

  return { services, durationMinutes, priceCentsTotal };
}

/**
 * The overlap re-check, and the only one. Must run INSIDE the lock above.
 *
 * Whatever availability said a moment ago, this is the answer that counts. The buffer
 * applies on both sides: a new appointment must not start within the turnaround of an
 * existing one, or vice versa.
 *
 * `excludeAppointmentId` is the single reason this is a function rather than two copies.
 * An appointment being MOVED must not be found to conflict with itself, and a second
 * implementation that forgot the exclusion would refuse every reschedule that nudged a
 * booking by five minutes — a bug that looks exactly like a race and is not one.
 */
async function assertNoOverlap(
  tx: TransactionClient,
  params: {
    barberId: string;
    startAt: Date;
    endAt: Date;
    bufferMs: number;
    excludeAppointmentId?: string;
  },
): Promise<void> {
  const conflict = await tx.appointment.findFirst({
    where: {
      barberId: params.barberId,
      status: { in: BLOCKING },
      startAt: { lt: new Date(params.endAt.getTime() + params.bufferMs) },
      endAt: { gt: new Date(params.startAt.getTime() - params.bufferMs) },
      ...(params.excludeAppointmentId === undefined
        ? {}
        : { id: { not: params.excludeAppointmentId } }),
    },
    select: { id: true, startAt: true },
  });

  if (conflict) {
    throw new ConflictError('Someone just took that time. Please pick another.');
  }
}

export async function createAppointment(input: CreateAppointmentInput) {
  const now = input.now ?? new Date();

  const settings = await prisma.shopSettings.findUnique({ where: { id: 1 } });
  if (!settings) throw new NotFoundError('Shop settings have not been set up.');

  /**
   * The shop-wide switch, checked before anything else — if online booking is off,
   * nothing about this request can make it acceptable.
   *
   * These three flags have been in the schema and the admin UI since the beginning
   * with nothing reading them, which was harmless only while no public client existed.
   * The walk-in side has always enforced its equivalents (`walkInQueueEnabled`,
   * `bookableWalkIn`); this brings the online path up to the same standard.
   */
  if (input.enforceOnlineRules && !settings.onlineBookingEnabled) {
    throw new ValidationError('Online booking is closed right now. Please call the shop.');
  }

  const barber = await prisma.barber.findUnique({ where: { id: input.barberId } });
  if (!barber) throw new NotFoundError('Barber not found.');
  if (barber.status !== 'ACTIVE') throw new ValidationError('That barber is not taking bookings.');
  if (input.enforceOnlineRules && !barber.acceptsOnline) {
    throw new ValidationError(`${barber.displayName} is not taking online bookings.`);
  }

  const { services, durationMinutes, priceCentsTotal } = await resolveServicesForBooking(
    input.serviceIds,
    input.enforceOnlineRules,
  );

  const startAt = input.startAt;
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);

  if (startAt.getTime() <= now.getTime()) {
    throw new ValidationError('That time has already passed.');
  }
  if (input.enforceMinimumNotice) {
    const earliest = now.getTime() + settings.minimumNoticeMinutes * 60_000;
    if (startAt.getTime() < earliest) {
      // "of notice", not "minutes' notice" — the possessive would render as
      // "1 hour' notice" the moment the shop sets an hour or more.
      throw new ValidationError(
        `Bookings need at least ${formatDuration(settings.minimumNoticeMinutes)} of notice.`,
      );
    }
  }

  // The phone number IS the client identity — normalisation, the findOrCreate and the
  // blocked check all live in `services/clients.ts`, which the queue join shares.
  const client = await findOrCreateClient(input.client, 'That number cannot book online.');

  const day = localShopDay(startAt, settings.timezone);
  const bufferMs = settings.bufferMinutes * 60_000;

  await ensureBarberDayLocks([{ barberId: input.barberId, day }]);

  /**
   * An INTERACTIVE transaction, so every statement below runs on one connection —
   * `FOR UPDATE` only holds a lock for the duration of the transaction that took it,
   * and Prisma's array form would spread these across connections.
   */
  const appointment = await prisma.$transaction(async (tx) => {
    await lockBarberDays(tx, [{ barberId: input.barberId, day }]);
    await assertNoOverlap(tx, { barberId: input.barberId, startAt, endAt, bufferMs });

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

  // Outside the transaction: the estimator reads committed rows, and holding the day
  // lock while it recomputes would serialise every booking behind it.
  await announceAppointmentChange(
    {
      appointmentId: appointment.id,
      action: APPOINTMENT_CHANGE.CREATED,
      barberIds: [appointment.barberId],
      startAts: [appointment.startAt],
    },
    now,
  );

  return appointment;
}

// --- Rescheduling ------------------------------------------------------------

export interface RescheduleAppointmentInput {
  appointmentId: string;
  /** UTC instant of the new start. */
  startAt: Date;
  /** Omitted keeps the current chair. */
  barberId?: string;
  /**
   * Omitted keeps the booked services — and therefore their snapshots, untouched.
   *
   * Supplied and genuinely different re-resolves from the live `Service` rows and
   * replaces the snapshot rows, because a new basket is a new snapshot taken at the
   * moment of the change. Supplied and identical is treated as omitted: moving a 2pm
   * cut to 3pm must not quietly reprice it because the menu went up on Tuesday.
   */
  serviceIds?: string[];
  enforceMinimumNotice: boolean;
  enforceOnlineRules: boolean;
  now?: Date;
}

/**
 * Moves an appointment to a new time, and optionally to a new chair.
 *
 * **The row keeps its id and its `cancelToken`.** Cancel-and-recreate was the obvious
 * alternative and is wrong four times over: it can cancel and then fail to create, with
 * no compensating transaction that survives a crash in between; it reissues a token that
 * was handed out exactly once, silently breaking the cancel link somebody already holds;
 * it orphans `Payment.appointmentId` and `QueueEntry.appointmentId` and double-counts one
 * visit in reporting; and it leaves a human to infer that a cancellation and an unrelated
 * creation an hour apart were the same haircut.
 *
 * The exclusion is the same one `createAppointment` uses — same lock, same overlap query,
 * with this appointment excluded from its own conflict check.
 */
export async function rescheduleAppointment(input: RescheduleAppointmentInput) {
  const now = input.now ?? new Date();

  const before = await prisma.appointment.findUnique({
    where: { id: input.appointmentId },
    include: { services: true },
  });
  if (!before) throw new NotFoundError('Appointment not found.');

  /**
   * Only a booked appointment can move, and each refusal says which one it is.
   *
   * Deliberately not folded into `ALLOWED_TRANSITIONS`: that table is about status, and
   * a reschedule does not change status at all. A cut that has started cannot be moved
   * because the client is in the chair, which is a different fact from a status graph.
   */
  if (before.status === 'IN_PROGRESS') {
    throw new ConflictError('That appointment has already started.');
  }
  if (before.status === 'COMPLETED') {
    throw new ConflictError('That appointment has already happened.');
  }
  if (before.status === 'CANCELLED') {
    throw new ConflictError('That appointment was cancelled.');
  }
  if (before.status === 'NO_SHOW') {
    throw new ConflictError('That appointment was marked as a no-show.');
  }

  const settings = await prisma.shopSettings.findUnique({ where: { id: 1 } });
  if (!settings) throw new NotFoundError('Shop settings have not been set up.');

  const startAt = input.startAt;
  if (startAt.getTime() <= now.getTime()) {
    throw new ValidationError('That time has already passed.');
  }

  if (input.enforceMinimumNotice) {
    const noticeMs = settings.minimumNoticeMinutes * 60_000;

    if (startAt.getTime() < now.getTime() + noticeMs) {
      throw new ValidationError(
        `Bookings need at least ${formatDuration(settings.minimumNoticeMinutes)} of notice.`,
      );
    }

    /**
     * The OLD start has to clear the window too.
     *
     * Moving a booking that starts in twenty minutes is functionally a cancellation of
     * it — the chair is given up at the same notice a cancellation would have given, and
     * `cancel` already refuses that. Checking only the new time would leave a way to
     * abandon a slot at five minutes' notice by "moving" it to next week.
     */
    if (before.startAt.getTime() - now.getTime() < noticeMs) {
      throw new ConflictError(
        'It is too close to your appointment to change it. Please call the shop.',
      );
    }
  }

  const nextBarberId = input.barberId ?? before.barberId;

  const barber = await prisma.barber.findUnique({ where: { id: nextBarberId } });
  if (!barber) throw new NotFoundError('Barber not found.');
  if (barber.status !== 'ACTIVE') throw new ValidationError('That barber is not taking bookings.');
  if (input.enforceOnlineRules && !barber.acceptsOnline) {
    throw new ValidationError(`${barber.displayName} is not taking online bookings.`);
  }

  const bookedServiceIds = before.services.map((service) => service.serviceId);
  const servicesChanged =
    input.serviceIds !== undefined &&
    !sameServiceSet(bookedServiceIds, input.serviceIds);

  /**
   * Unchanged services read their duration and price from the SNAPSHOT rows, never from
   * the live menu. That is the whole point of snapshotting: a move is not a repricing,
   * and a service that went up five dollars on Tuesday must not silently follow a cut
   * that was booked on Monday.
   */
  let durationMinutes = before.durationMinutes;
  let priceCentsTotal = before.priceCentsTotal;
  let snapshots: {
    serviceId: string;
    priceCents: number;
    durationMinutes: number;
    nameSnapshot: string;
  }[] = [];

  if (servicesChanged) {
    const resolved = await resolveServicesForBooking(
      input.serviceIds ?? [],
      input.enforceOnlineRules,
    );
    durationMinutes = resolved.durationMinutes;
    priceCentsTotal = resolved.priceCentsTotal;
    snapshots = resolved.services.map((service) => ({
      serviceId: service.id,
      priceCents: service.priceCents,
      durationMinutes: service.durationMinutes,
      nameSnapshot: service.name,
    }));
  }

  /**
   * A cross-barber move is the one place this system hands somebody else's work to a
   * barber who may not do it, so capability is checked here even though
   * `createAppointment` does not check it yet — the booking clients filter the roster
   * before they ever offer a chair, and a voice caller has no such list in front of them.
   */
  if (nextBarberId !== before.barberId) {
    const serviceIds = servicesChanged ? (input.serviceIds ?? []) : bookedServiceIds;
    const offered = await prisma.barberService.findMany({
      where: { barberId: nextBarberId, serviceId: { in: serviceIds } },
      select: { serviceId: true },
    });

    if (offered.length !== new Set(serviceIds).size) {
      throw new ValidationError(`${barber.displayName} does not do all of those services.`);
    }
  }

  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);
  const bufferMs = settings.bufferMinutes * 60_000;

  /**
   * Both days, even though only the destination can produce an overlap — vacating a slot
   * cannot create one. Locking the origin as well means the slot this move frees becomes
   * visible to a competing booking atomically with the move itself, rather than in the
   * window between the update and the commit. `orderLockKeys` dedupes, so a same-barber
   * same-day nudge still takes exactly one lock.
   */
  const lockKeys: BarberDayKey[] = [
    { barberId: before.barberId, day: localShopDay(before.startAt, settings.timezone) },
    { barberId: nextBarberId, day: localShopDay(startAt, settings.timezone) },
  ];

  await ensureBarberDayLocks(lockKeys);

  const appointment = await prisma.$transaction(async (tx) => {
    await lockBarberDays(tx, lockKeys);

    await assertNoOverlap(tx, {
      barberId: nextBarberId,
      startAt,
      endAt,
      bufferMs,
      // Without this, nudging a 60-minute cut from 10:00 to 10:15 finds itself and
      // refuses — a failure that reads exactly like a race and is not one.
      excludeAppointmentId: input.appointmentId,
    });

    return tx.appointment.update({
      where: { id: input.appointmentId },
      data: {
        barberId: nextBarberId,
        startAt,
        endAt,
        durationMinutes,
        ...(servicesChanged
          ? { priceCentsTotal, services: { deleteMany: {}, create: snapshots } }
          : {}),
      },
      include: { services: true, client: true, barber: true },
    });
  });

  /**
   * Both chairs changed shape, so both are announced — and both instants, because a board
   * showing the day this booking LEFT has to refetch in order for it to disappear. That
   * is the case the arrays in the payload exist for.
   */
  await announceAppointmentChange(
    {
      appointmentId: appointment.id,
      action: APPOINTMENT_CHANGE.RESCHEDULED,
      barberIds: [before.barberId, appointment.barberId],
      startAts: [before.startAt, appointment.startAt],
    },
    now,
  );

  return appointment;
}

/** Set equality, so re-sending the same basket in a different order is not a change. */
function sameServiceSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

// --- Reads -------------------------------------------------------------------

export function getAppointment(appointmentId: string) {
  return prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { services: true, client: true, barber: true },
  });
}

/**
 * Whose chair an appointment belongs to, for the self-or-admin check.
 *
 * The mirror of `getPaymentOwner`, and it exists for the same reason: the routes that
 * cancel an appointment or move its status name the *appointment*, so a middleware
 * taking a synchronous getter cannot know the barber. They load the owner and call
 * `assertBarberSelfOrAdmin` with it.
 *
 * Selects the one column rather than reusing `getAppointment`, so an authorisation
 * check never pulls a client row — including their name and phone — into a request
 * that may be about to be refused.
 */
export async function getAppointmentOwner(appointmentId: string): Promise<string> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { barberId: true },
  });

  if (!appointment) throw new NotFoundError('That appointment does not exist.');
  return appointment.barberId;
}

/**
 * Looks an appointment up by its cancel token.
 *
 * The token is the credential — it is 25 characters of cuid, never guessable by walking
 * ids, and it is handed out exactly once to the person who made the booking.
 */
export function getAppointmentByToken(token: string) {
  return prisma.appointment.findUnique({
    where: { cancelToken: token },
    include: { services: true, client: true, barber: true },
  });
}

/**
 * What one client still has coming up.
 *
 * **Upcoming only, and never history.** This is the read the phone receptionist makes on
 * behalf of whoever dialled, and caller ID is an unverified identity — so it answers the
 * narrowest useful question. Past visits, notes, spend and no-show counts are all things
 * the desk may see and a caller may not, and the way to keep it that way is for this
 * function not to be able to return them.
 *
 * Cancelled and no-show rows are excluded: they are not appointments the client has, they
 * are appointments the client had.
 */
export function listUpcomingAppointmentsForClient(
  clientId: string,
  now: Date,
  limit = 5,
) {
  return prisma.appointment.findMany({
    where: {
      clientId,
      status: { in: BLOCKING },
      startAt: { gte: now },
    },
    orderBy: { startAt: 'asc' },
    take: limit,
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

  const cancelled = await prisma.appointment.update({
    where: { id: appointment.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: now,
      cancelReason: options.reason ?? null,
    },
  });

  /**
   * The chair is free again, so somebody waiting may now be seen sooner — and the book
   * has a hole in it.
   *
   * Read from `cancelled`, the updated row, rather than from the argument: this
   * function's parameter is narrowed to the three fields it actually reads, and that
   * narrowing is a statement worth keeping. Widening it to carry a barber id for the
   * announcement would trade a precise type for data the update already returned.
   */
  await announceAppointmentChange(
    {
      appointmentId: cancelled.id,
      action: APPOINTMENT_CHANGE.CANCELLED,
      barberIds: [cancelled.barberId],
      startAts: [cancelled.startAt],
    },
    now,
  );

  return cancelled;
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

export async function updateAppointmentStatus(
  appointmentId: string,
  next: AppointmentStatus,
  now: Date = new Date(),
) {
  const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appointment) throw new NotFoundError('Appointment not found.');

  if (!ALLOWED_TRANSITIONS[appointment.status].includes(next)) {
    throw new ConflictError(
      `An appointment that is ${appointment.status.toLowerCase()} cannot become ${next.toLowerCase()}.`,
    );
  }

  const updated = await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      status: next,
      // The injected clock, so a stamped time and a recomputed estimate cannot come
      // from two different moments.
      ...(next === 'CANCELLED' ? { cancelledAt: now } : {}),
      /**
       * When they ACTUALLY sat down — the moment somebody pressed Start, not the time
       * the slot was booked for.
       *
       * This is what lets the estimator know a chair is occupied right now. Without it a
       * client who turns up early, or a cut that runs long, leaves the wall display
       * reading "Free now" at a barber who is visibly cutting hair.
       */
      ...(next === 'IN_PROGRESS' ? { startedAt: now } : {}),
    },
  });

  // CANCELLED and NO_SHOW free the chair; the others do not, but the recompute is
  // cheap and unconditional beats a condition that has to be kept in step with
  // `BLOCKING`. The same reasoning applies to announcing it: a status change repaints
  // the row on every board showing that day.
  await announceAppointmentChange(
    {
      appointmentId: updated.id,
      action: APPOINTMENT_CHANGE.STATUS_CHANGED,
      barberIds: [updated.barberId],
      startAts: [updated.startAt],
    },
    now,
  );

  return updated;
}
