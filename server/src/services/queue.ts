/**
 * The walk-in queue.
 *
 * A queue that is only a queue is easy and wrong. Serve it naively — first in, first
 * out, next free chair — and the first busy Saturday it seats a walk-in at 2:00pm into
 * a slot somebody booked online on Wednesday. The line at the door and the calendar
 * are competing for the same finite thing, and only one of them is written down.
 *
 * So the estimator schedules walk-ins into the gaps *between* booked appointments,
 * using the same free-time algebra the booking engine uses. `computeFreeIntervals`
 * hands each chair its genuinely free stretches; this file decides who goes where.
 *
 * Three properties are deliberate and worth not undoing:
 *
 * - **Order is derived, never stored.** `(priority DESC, joinedAt ASC)` is computed on
 *   every read. A stored `position` column is a number two concurrent requests can
 *   disagree about, and reshuffling it on every join is a race-condition factory.
 * - **`assignQueue` is pure**, with `now` injected. The estimator is the part most
 *   likely to be wrong, so it is the part that can be exercised against a fixed clock
 *   instead of a real one.
 * - **Assignment is a projection, not a claim.** A client who did not name a barber
 *   shows an estimate against whichever chair frees up first, and that can change as
 *   the board moves. `callNext` is the only thing that actually attaches them.
 */

import {
  ACTIVE_QUEUE_STATUSES,
  QUEUE_STATUS,
  type AppointmentSource,
  type QueueStatus,
} from '@francis/shared';
import { DateTime } from 'luxon';

import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { broadcastQueueBoard } from '../realtime/broadcast.js';
import { findOrCreateClient } from './clients.js';
import { computeFreeIntervals, loadDaySnapshots } from './availability.js';
import {
  intersectIntervals,
  mergeIntervals,
  subtractIntervals,
  type Interval,
} from './intervals.js';

// --- The estimator (pure) ----------------------------------------------------

export interface QueueChair {
  barberId: string;
  /** Tiebreak when two chairs free up at the same instant, so the board is stable. */
  sortOrder: number;
  /** What this barber can perform, for placing an "anyone" entry. */
  serviceIds: readonly string[];
  /** Free stretches today, already minus booked appointments and the buffer. */
  free: readonly Interval[];
}

export interface QueueCandidate {
  id: string;
  /** The barber they are attached to. Null means "anyone" and still unclaimed. */
  barberId: string | null;
  serviceIds: readonly string[];
  durationMinutes: number;
  priority: number;
  joinedAt: Date;
  status: QueueStatus;
  /** Set once they are in the chair — the estimate stops guessing at that point. */
  startedAt: Date | null;
}

export interface QueueAssignment {
  entryId: string;
  /** 1-based among those still waiting; 0 once called or seated. */
  position: number;
  assignedBarberId: string | null;
  /** When the chair is expected to be ready — the seat time, not the finish time. */
  estimatedReadyAt: Date | null;
  /** Set only when nobody can fit them before closing. */
  unservableReason: string | null;
}

export interface QueueChairState {
  barberId: string;
  nowServingEntryId: string | null;
  /**
   * When this barber is next free, or null if they are done for the day.
   *
   * Measured **before** the waiting line is allocated — the question a chair card
   * answers is "is this barber available", not "when does the queue run out". Counting
   * the queue would have a barber standing idle beside a card reading "free from 1:44",
   * because the person the estimator pencilled in is still sitting in the waiting area.
   */
  freeFrom: Date | null;
  waitingCount: number;
}

export interface QueueEstimate {
  /** In board order: priority first, then arrival. */
  assignments: QueueAssignment[];
  chairs: QueueChairState[];
}

export interface AssignQueueInput {
  now: Date;
  bufferMinutes: number;
  chairs: readonly QueueChair[];
  entries: readonly QueueCandidate[];
}

/** Far enough out to act as "no upper bound" when clipping an interval. */
const END_OF_TIME = new Date(8_640_000_000_000_000);

interface ChairState {
  barberId: string;
  sortOrder: number;
  serviceIds: Set<string>;
  free: Interval[];
  nowServingEntryId: string | null;
  waitingCount: number;
  /** Snapshotted once the chair's current occupant is accounted for. */
  freeFrom: Date | null;
}

/** The published order: higher priority first, then whoever arrived first. */
function boardOrder(a: QueueCandidate, b: QueueCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.joinedAt.getTime() !== b.joinedAt.getTime()) {
    return a.joinedAt.getTime() - b.joinedAt.getTime();
  }
  // Two entries in the same millisecond still need one answer, not two.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The first stretch long enough to hold the whole service. */
function earliestFit(free: readonly Interval[], durationMs: number): Date | null {
  for (const interval of free) {
    if (interval.end.getTime() - interval.start.getTime() >= durationMs) return interval.start;
  }
  return null;
}

function reserve(chair: ChairState, start: Date, durationMs: number, bufferMs: number): void {
  const end = new Date(start.getTime() + durationMs + bufferMs);
  chair.free = subtractIntervals(chair.free, [{ start, end }]);
}

export function assignQueue(input: AssignQueueInput): QueueEstimate {
  const bufferMs = input.bufferMinutes * 60_000;

  const chairs = new Map<string, ChairState>(
    input.chairs.map((chair) => [
      chair.barberId,
      {
        barberId: chair.barberId,
        sortOrder: chair.sortOrder,
        serviceIds: new Set(chair.serviceIds),
        // Nothing before now is available to promise, whatever the schedule says.
        free: intersectIntervals(mergeIntervals(chair.free), [
          { start: input.now, end: END_OF_TIME },
        ]),
        nowServingEntryId: null,
        waitingCount: 0,
        freeFrom: null,
      },
    ]),
  );

  const ordered = [...input.entries].sort(boardOrder);
  const assignments = new Map<string, QueueAssignment>();

  /**
   * Anyone already called or in the chair is consuming their barber's time right now,
   * so their block comes out before a single waiting client is placed. Skipping this
   * would quote the next person a time the chair is not actually free.
   */
  for (const entry of ordered) {
    if (entry.status !== QUEUE_STATUS.CALLED && entry.status !== QUEUE_STATUS.IN_CHAIR) continue;

    const chair = entry.barberId === null ? undefined : chairs.get(entry.barberId);
    // A seated client's clock started when they sat down; a called one is on their way.
    const start = entry.status === QUEUE_STATUS.IN_CHAIR ? (entry.startedAt ?? input.now) : input.now;

    if (chair) {
      reserve(chair, start, entry.durationMinutes * 60_000, bufferMs);
      if (entry.status === QUEUE_STATUS.IN_CHAIR) chair.nowServingEntryId = entry.id;
    }

    assignments.set(entry.id, {
      entryId: entry.id,
      position: 0,
      assignedBarberId: entry.barberId,
      estimatedReadyAt: start,
      unservableReason: null,
    });
  }

  /**
   * Taken here, between the two passes: the chair's current occupant has been
   * subtracted, but nobody still in the waiting area has been. That is what makes it
   * mean "this barber is available at" rather than "this barber's line ends at".
   */
  for (const chair of chairs.values()) {
    chair.freeFrom = chair.free[0]?.start ?? null;
  }

  const waiting = ordered.filter((entry) => entry.status === QUEUE_STATUS.WAITING);

  waiting.forEach((entry, index) => {
    const durationMs = entry.durationMinutes * 60_000;

    /**
     * A named barber means that chair or nothing. "Anyone" means any chair that can
     * actually perform every service they asked for — offering a beard trim from a
     * barber who does not do beard trims is not a shorter wait, it is a wrong answer.
     */
    const eligible =
      entry.barberId === null
        ? [...chairs.values()].filter((chair) =>
            entry.serviceIds.every((serviceId) => chair.serviceIds.has(serviceId)),
          )
        : [chairs.get(entry.barberId)].filter((chair): chair is ChairState => chair !== undefined);

    let best: { chair: ChairState; start: Date } | null = null;
    for (const chair of eligible) {
      const start = earliestFit(chair.free, durationMs);
      if (start === null) continue;
      if (
        best === null ||
        start < best.start ||
        (start.getTime() === best.start.getTime() && chair.sortOrder < best.chair.sortOrder)
      ) {
        best = { chair, start };
      }
    }

    if (best === null) {
      assignments.set(entry.id, {
        entryId: entry.id,
        position: index + 1,
        assignedBarberId: null,
        estimatedReadyAt: null,
        unservableReason:
          eligible.length === 0
            ? 'No barber on today does all of those services.'
            : 'No opening left before closing.',
      });
      return;
    }

    /**
     * Reserved before the next entry is considered, which is what makes the line hold:
     * whoever is placed first owns that time, and everyone after can only use what is
     * left. A shorter cut later in the line may well land in a gap ahead of a longer
     * one — that costs the longer one nothing, since its time is already fixed, and it
     * is exactly what a good receptionist does with a spare fifteen minutes.
     */
    reserve(best.chair, best.start, durationMs, bufferMs);
    best.chair.waitingCount += 1;

    assignments.set(entry.id, {
      entryId: entry.id,
      position: index + 1,
      assignedBarberId: best.chair.barberId,
      estimatedReadyAt: best.start,
      unservableReason: null,
    });
  });

  return {
    assignments: ordered.map(
      (entry) =>
        assignments.get(entry.id) ?? {
          entryId: entry.id,
          position: 0,
          assignedBarberId: entry.barberId,
          estimatedReadyAt: null,
          unservableReason: null,
        },
    ),
    chairs: [...chairs.values()].map((chair) => ({
      barberId: chair.barberId,
      nowServingEntryId: chair.nowServingEntryId,
      freeFrom: chair.freeFrom,
      waitingCount: chair.waitingCount,
    })),
  };
}

// --- Loading the board -------------------------------------------------------

const ACTIVE: QueueStatus[] = [...ACTIVE_QUEUE_STATUSES];

const ENTRY_INCLUDE = {
  client: true,
  barber: true,
  services: true,
} as const;

export interface QueueBoardQuery {
  now?: Date;
}

/**
 * The whole board: who is waiting, in what order, and when each chair frees up.
 *
 * Note which barbers become chairs. The obvious answer — everyone active who takes
 * walk-ins — silently drops anyone who was switched off mid-shift, taking whoever is
 * sitting in their chair off the board with them. So the set is that, plus every
 * barber an active entry is already attached to.
 */
export async function getQueueBoard(query: QueueBoardQuery = {}) {
  const now = query.now ?? new Date();

  const settings = await prisma.shopSettings.findUnique({ where: { id: 1 } });
  if (!settings) throw new NotFoundError('Shop settings have not been set up.');

  const [walkInBarbers, entries] = await Promise.all([
    prisma.barber.findMany({
      where: { status: 'ACTIVE', acceptsWalkIns: true },
      include: { services: { select: { serviceId: true } } },
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
    }),
    prisma.queueEntry.findMany({
      where: { status: { in: ACTIVE } },
      include: ENTRY_INCLUDE,
      orderBy: [{ priority: 'desc' }, { joinedAt: 'asc' }],
    }),
  ]);

  const attachedIds = new Set(
    entries.map((entry) => entry.barberId).filter((id): id is string => id !== null),
  );
  const missing = [...attachedIds].filter(
    (id) => !walkInBarbers.some((barber) => barber.id === id),
  );
  const strandedBarbers =
    missing.length === 0
      ? []
      : await prisma.barber.findMany({
          where: { id: { in: missing } },
          include: { services: { select: { serviceId: true } } },
          orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
        });

  const barbers = [...walkInBarbers, ...strandedBarbers];
  const today = DateTime.fromJSDate(now).setZone(settings.timezone).toFormat('yyyy-MM-dd');

  const snapshots = await loadDaySnapshots(
    barbers.map((barber) => barber.id),
    today,
    settings.timezone,
  );

  const chairs: QueueChair[] = barbers.map((barber) => {
    const snapshot = snapshots.get(barber.id);
    /**
     * `busy` is appointments ONLY here. Availability subtracts the queue on top of
     * this; feeding the queue's own commitments back in at this point would have the
     * estimator scheduling around itself and walking everyone later on every refresh.
     */
    const free =
      snapshot === undefined
        ? []
        : computeFreeIntervals({
            date: today,
            timezone: settings.timezone,
            bufferMinutes: settings.bufferMinutes,
            bookingHorizonDays: settings.bookingHorizonDays,
            now,
            barberSchedules: snapshot.barberSchedules,
            shopHours: snapshot.shopHours,
            shopClosures: snapshot.shopClosures,
            scheduleExceptions: snapshot.scheduleExceptions,
            busy: snapshot.appointments,
          }).free;

    return {
      barberId: barber.id,
      sortOrder: barber.sortOrder,
      serviceIds: barber.services.map((row) => row.serviceId),
      free,
    };
  });

  const estimate = assignQueue({
    now,
    bufferMinutes: settings.bufferMinutes,
    chairs,
    entries: entries.map((entry) => ({
      id: entry.id,
      barberId: entry.barberId,
      serviceIds: entry.services.map((row) => row.serviceId),
      durationMinutes: entry.durationMinutes,
      priority: entry.priority,
      joinedAt: entry.joinedAt,
      status: entry.status,
      startedAt: entry.startedAt,
    })),
  });

  const byId = new Map(estimate.assignments.map((assignment) => [assignment.entryId, assignment]));
  const nameById = new Map(barbers.map((barber) => [barber.id, barber.displayName]));

  return {
    generatedAt: now,
    queueEnabled: settings.walkInQueueEnabled,
    chairs: estimate.chairs.map((chair) => ({
      ...chair,
      displayName: nameById.get(chair.barberId) ?? 'Unknown',
    })),
    entries: entries.map((entry) => {
      const assignment = byId.get(entry.id) ?? null;
      const assignedBarberId = assignment?.assignedBarberId ?? null;
      return {
        entry,
        assignment,
        assignedBarberName:
          assignedBarberId === null ? null : (nameById.get(assignedBarberId) ?? null),
      };
    }),
  };
}

export type QueueBoard = Awaited<ReturnType<typeof getQueueBoard>>;

/**
 * Writes the estimate back onto the rows.
 *
 * Persisted for one reason: `loadQueueCommitments` in the availability engine reads it
 * to stop an online slot being sold over a walk-in who has already been promised that
 * time. Only rows whose estimate actually moved are written, so a refresh on an
 * unchanged board is a read.
 */
export async function refreshQueueEstimates(now: Date = new Date()): Promise<QueueBoard> {
  const board = await getQueueBoard({ now });

  const changed = board.entries.filter(
    (row) =>
      (row.entry.estimatedReadyAt?.getTime() ?? null) !==
      (row.assignment?.estimatedReadyAt?.getTime() ?? null),
  );

  if (changed.length > 0) {
    /**
     * Sorted by id, which is not cosmetic.
     *
     * Two of these can run at once — two barbers tapping "Next" in the same second —
     * and each takes a row lock per update. Acquiring them in board order means one
     * transaction can hold row B while waiting for A as the other holds A and waits
     * for B, and InnoDB resolves that by killing one of them. A fixed, arbitrary
     * order across every caller makes the deadlock impossible rather than unlikely.
     */
    const ordered = [...changed].sort((a, b) => (a.entry.id < b.entry.id ? -1 : 1));

    await prisma.$transaction(
      ordered.map((row) =>
        prisma.queueEntry.update({
          where: { id: row.entry.id },
          data: { estimatedReadyAt: row.assignment?.estimatedReadyAt ?? null },
        }),
      ),
    );
  }

  /**
   * The single broadcast point for the whole system.
   *
   * Every write — join, call, seat, reorder, and now every appointment mutation too —
   * comes through here, so a new path cannot forget to tell the shop. Putting it in the
   * routes instead would mean the same line in five handlers, and `POST /queue` does not
   * share the others' response helper, so that is exactly the one that would be missed.
   *
   * Emitted after the estimates are committed, never instead of them: the socket is a
   * notification, and the REST response remains the answer of record.
   */
  broadcastQueueBoard(board);

  return board;
}

export function getQueueEntry(entryId: string) {
  return prisma.queueEntry.findUnique({ where: { id: entryId }, include: ENTRY_INCLUDE });
}

export type QueueEntryWithRelations = NonNullable<Awaited<ReturnType<typeof getQueueEntry>>>;

/**
 * What every mutation returns.
 *
 * The entry is what gets audited; the board is what gets sent back. They come as a
 * pair because a change to one person reorders everyone — returning the single row
 * would hand the caller a position that was already wrong — and because the estimator
 * has just run, so recomputing the board in the route would be the second time.
 */
export interface QueueMutation {
  entry: QueueEntryWithRelations;
  board: QueueBoard;
}

async function withBoard(entryId: string, board: QueueBoard): Promise<QueueMutation> {
  const entry = await getQueueEntry(entryId);
  if (!entry) throw new NotFoundError('That person is not in the queue.');
  return { entry, board };
}

// --- Joining -----------------------------------------------------------------

export interface JoinQueueInput {
  client: { phone: string; firstName: string; lastName?: string | null | undefined };
  serviceIds: string[];
  /** Null or omitted means "anyone". */
  barberId?: string | null;
  source: AppointmentSource;
  notes?: string | null;
  now?: Date;
}

export async function joinQueue(input: JoinQueueInput): Promise<QueueMutation> {
  const now = input.now ?? new Date();

  const settings = await prisma.shopSettings.findUnique({ where: { id: 1 } });
  if (!settings) throw new NotFoundError('Shop settings have not been set up.');
  if (!settings.walkInQueueEnabled) {
    throw new ValidationError('The shop is not taking walk-ins right now.');
  }

  if (input.serviceIds.length === 0) throw new ValidationError('Choose at least one service.');

  const services = await prisma.service.findMany({ where: { id: { in: input.serviceIds } } });
  if (services.length !== new Set(input.serviceIds).size) {
    throw new ValidationError('One of those services no longer exists.');
  }

  const inactive = services.find((service) => !service.isActive);
  if (inactive) throw new ValidationError(`${inactive.name} is no longer offered.`);
  // Separate from `isActive` on purpose: the shop can keep selling a two-hour colour
  // by appointment while refusing to promise one to a queue that has to keep moving.
  const notWalkIn = services.find((service) => !service.bookableWalkIn);
  if (notWalkIn) throw new ValidationError(`${notWalkIn.name} has to be booked in advance.`);

  /**
   * Computed here from the Service rows, exactly as `createAppointment` does, and for
   * the same reason: a caller that could name its own duration could claim a chair for
   * five minutes and sit in it for an hour.
   */
  const durationMinutes = services.reduce((total, service) => total + service.durationMinutes, 0);
  const priceCentsTotal = services.reduce((total, service) => total + service.priceCents, 0);
  if (durationMinutes <= 0) throw new ValidationError('That service has no duration.');

  const barberId = input.barberId ?? null;
  if (barberId !== null) {
    const barber = await prisma.barber.findUnique({
      where: { id: barberId },
      include: { services: { select: { serviceId: true } } },
    });
    if (!barber) throw new NotFoundError('Barber not found.');
    if (barber.status !== 'ACTIVE' || !barber.acceptsWalkIns) {
      throw new ValidationError('That barber is not taking walk-ins today.');
    }
    const capable = new Set(barber.services.map((row) => row.serviceId));
    if (!input.serviceIds.every((serviceId) => capable.has(serviceId))) {
      throw new ValidationError('That barber does not do all of those services.');
    }
  }

  const client = await findOrCreateClient(input.client, 'That number cannot join the queue.');

  /**
   * One active entry per client. A kiosk double-tap and a deliberate re-join to get a
   * better estimate produce the same two rows, and the second one quietly costs the
   * whole line a slot. Enforced here rather than by a constraint because MySQL cannot
   * express "unique among rows in these three statuses".
   */
  const existing = await prisma.queueEntry.findFirst({
    where: { clientId: client.id, status: { in: ACTIVE } },
    select: { id: true },
  });
  if (existing) throw new ConflictError('You are already in the queue.');

  const entry = await prisma.queueEntry.create({
    data: {
      clientId: client.id,
      barberId,
      durationMinutes,
      priceCentsTotal,
      source: input.source,
      notes: input.notes ?? null,
      joinedAt: now,
      services: {
        create: services.map((service) => ({
          serviceId: service.id,
          // Snapshotted, so a price change tomorrow never rewrites today's cut.
          priceCents: service.priceCents,
          durationMinutes: service.durationMinutes,
          nameSnapshot: service.name,
        })),
      },
    },
    include: ENTRY_INCLUDE,
  });

  return withBoard(entry.id, await refreshQueueEstimates(now));
}

// --- Calling the next client -------------------------------------------------

/**
 * Hands a barber the next person in line, claiming them if they asked for "anyone".
 *
 * This is the one genuine race in the queue. Two barbers finish at the same moment,
 * both tap "Next", and both are shown the same client — who then gets called twice and
 * seated once, while the person behind them never moves.
 *
 * The candidate row is locked with `SELECT ... FOR UPDATE` and re-checked **inside**
 * the lock, the same shape as the booking transaction. InnoDB's locking read returns
 * the latest committed row rather than the transaction's snapshot, so the second
 * barber sees `CALLED` and moves on to the next person instead of colliding.
 */
export async function callNext(barberId: string, now: Date = new Date()): Promise<QueueMutation> {
  const barber = await prisma.barber.findUnique({
    where: { id: barberId },
    include: { services: { select: { serviceId: true } } },
  });
  if (!barber) throw new NotFoundError('Barber not found.');
  const capable = new Set(barber.services.map((row) => row.serviceId));

  const called = await prisma.$transaction(async (tx) => {
    const candidates = await tx.queueEntry.findMany({
      where: {
        status: QUEUE_STATUS.WAITING,
        OR: [{ barberId }, { barberId: null }],
      },
      orderBy: [{ priority: 'desc' }, { joinedAt: 'asc' }, { id: 'asc' }],
      include: { services: { select: { serviceId: true } } },
    });

    for (const candidate of candidates) {
      // An unclaimed entry only counts if this barber can actually do the work.
      if (
        candidate.barberId === null &&
        !candidate.services.every((row) => capable.has(row.serviceId))
      ) {
        continue;
      }

      const locked = await tx.$queryRaw<{ status: QueueStatus }[]>`
        SELECT status FROM queue_entries WHERE id = ${candidate.id} FOR UPDATE
      `;
      // Somebody else took them between the read above and the lock.
      if (locked[0]?.status !== QUEUE_STATUS.WAITING) continue;

      return tx.queueEntry.update({
        where: { id: candidate.id },
        data: { status: QUEUE_STATUS.CALLED, calledAt: now, barberId },
        include: ENTRY_INCLUDE,
      });
    }

    return null;
  });

  if (!called) throw new NotFoundError('Nobody is waiting for you right now.');

  return withBoard(called.id, await refreshQueueEstimates(now));
}

// --- Status ------------------------------------------------------------------

/**
 * Only the moves that describe something that can actually happen in a shop.
 *
 * `CALLED -> WAITING` is deliberately allowed: someone called at the door who stepped
 * out for a coffee goes back in the line rather than being marked a no-show, and they
 * keep their original `joinedAt`, so they do not lose their place for it.
 */
const ALLOWED_TRANSITIONS: Record<QueueStatus, QueueStatus[]> = {
  WAITING: [QUEUE_STATUS.CALLED, QUEUE_STATUS.IN_CHAIR, QUEUE_STATUS.CANCELLED, QUEUE_STATUS.NO_SHOW],
  CALLED: [
    QUEUE_STATUS.IN_CHAIR,
    QUEUE_STATUS.WAITING,
    QUEUE_STATUS.CANCELLED,
    QUEUE_STATUS.NO_SHOW,
  ],
  IN_CHAIR: [QUEUE_STATUS.COMPLETED, QUEUE_STATUS.CANCELLED],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export async function updateQueueStatus(
  entryId: string,
  next: QueueStatus,
  now: Date = new Date(),
): Promise<QueueMutation> {
  const entry = await prisma.queueEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError('That person is not in the queue.');

  if (!ALLOWED_TRANSITIONS[entry.status].includes(next)) {
    throw new ConflictError(
      `Someone who is ${entry.status.toLowerCase().replace('_', ' ')} cannot become ${next.toLowerCase().replace('_', ' ')}.`,
    );
  }

  if (next === QUEUE_STATUS.IN_CHAIR && entry.barberId === null) {
    throw new ValidationError('Assign a barber before seating someone.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({
      where: { id: entryId },
      data: {
        status: next,
        ...(next === QUEUE_STATUS.CALLED && entry.calledAt === null ? { calledAt: now } : {}),
        ...(next === QUEUE_STATUS.IN_CHAIR ? { startedAt: now } : {}),
        ...(next === QUEUE_STATUS.COMPLETED ? { completedAt: now } : {}),
        // Back in the line: the earlier call no longer holds their barber's time.
        ...(next === QUEUE_STATUS.WAITING ? { calledAt: null } : {}),
      },
    });

    /**
     * `visitCount`, `noShowCount` and `lastVisitAt` have existed since the schema
     * landed with nothing writing to them. A completed walk-in is the first event that
     * genuinely means "this person came in", so this is where they start counting.
     */
    if (next === QUEUE_STATUS.COMPLETED) {
      await tx.client.update({
        where: { id: entry.clientId },
        data: { visitCount: { increment: 1 }, lastVisitAt: now },
      });
    }
    if (next === QUEUE_STATUS.NO_SHOW) {
      await tx.client.update({
        where: { id: entry.clientId },
        data: { noShowCount: { increment: 1 } },
      });
    }
  });

  return withBoard(entryId, await refreshQueueEstimates(now));
}

// --- Reordering --------------------------------------------------------------

export async function setQueuePriority(
  entryId: string,
  priority: number,
  now: Date = new Date(),
): Promise<QueueMutation> {
  const entry = await prisma.queueEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError('That person is not in the queue.');
  if (!ACTIVE.includes(entry.status)) {
    throw new ConflictError('That person has already left the queue.');
  }

  await prisma.queueEntry.update({ where: { id: entryId }, data: { priority } });
  return withBoard(entryId, await refreshQueueEstimates(now));
}

/** Moves someone to a different chair, or back to "anyone" with null. */
export async function assignQueueBarber(
  entryId: string,
  barberId: string | null,
  now: Date = new Date(),
): Promise<QueueMutation> {
  const entry = await prisma.queueEntry.findUnique({
    where: { id: entryId },
    include: { services: { select: { serviceId: true } } },
  });
  if (!entry) throw new NotFoundError('That person is not in the queue.');
  if (!ACTIVE.includes(entry.status)) {
    throw new ConflictError('That person has already left the queue.');
  }
  if (barberId === null && entry.status !== QUEUE_STATUS.WAITING) {
    throw new ConflictError('Someone already called cannot go back to "anyone".');
  }

  if (barberId !== null) {
    const barber = await prisma.barber.findUnique({
      where: { id: barberId },
      include: { services: { select: { serviceId: true } } },
    });
    if (!barber) throw new NotFoundError('Barber not found.');
    const capable = new Set(barber.services.map((row) => row.serviceId));
    if (!entry.services.every((row) => capable.has(row.serviceId))) {
      throw new ValidationError('That barber does not do all of those services.');
    }
  }

  await prisma.queueEntry.update({ where: { id: entryId }, data: { barberId } });
  return withBoard(entryId, await refreshQueueEstimates(now));
}
