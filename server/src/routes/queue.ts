/**
 * The walk-in queue.
 *
 * Two boards, two audiences. `/queue` is the staff board and carries phone numbers;
 * `/queue/board` is what a paired kiosk or wall display reads, and is redacted by
 * construction in the mapper rather than by omission here.
 *
 * A device may read — the board, and the kiosk's own quote — but joining is the only
 * WRITE it can reach. Everything that moves the line — calling, seating, reordering — is
 * staff-only, and because `req.auth` is a
 * discriminated union with no `roles` on the device arm, a kiosk token cannot satisfy
 * those guards even if someone puts one on the request. The compiler enforces it, not
 * a runtime check that could be forgotten.
 */

import {
  assignQueueBarberRequestSchema,
  callNextRequestSchema,
  joinQueueRequestSchema,
  normalizePhone,
  setQueuePriorityRequestSchema,
  updateQueueStatusRequestSchema,
  walkInQuoteQuerySchema,
  type PublicQueueBoardDto,
  type QueueBoardDto,
  type WalkInQuoteDto,
} from '@francis/shared';
import { Router, type Request, type Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import type { QueueStatus } from '../generated/prisma/enums.js';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors.js';
import { limiter } from '../lib/rate-limit.js';
import { pathParam } from '../lib/http.js';
import { toPublicQueueBoardDto, toQueueBoardDto, toWalkInQuoteDto } from '../mappers/queue.js';
import {
  assertBarberSelfOrAdmin,
  requireBarberSelfOrAdmin,
  requireDevice,
  requireUser,
} from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import {
  assignQueueBarber,
  callNext,
  getQueueBoard,
  getQueueEntry,
  joinQueue,
  quoteWalkIn,
  setQueuePriority,
  updateQueueStatus,
  type QueueMutation,
} from '../services/queue.js';

export const queueRouter: Router = Router();

/**
 * The kiosk sits in the shop, so every join from it shares one IP — an IP limit alone
 * would throttle the whole shop on a busy morning. Both limits are generous for that
 * reason, and the per-phone limit is the one doing the real work: it stops one person
 * refilling the line, which an IP limit cannot see behind a single kiosk.
 */
const joinIpLimit = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  message: 'The shop has taken a lot of walk-ins just now. Please ask at the desk.',
});

const joinPhoneLimit = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: 'That number has joined the queue several times already today.',
  /**
   * Staff are not rate-limited by their customer's number.
   *
   * The limiter is registered before any auth check, so the desk shared this bucket with
   * the public: one parent booking four children under one number came within a booking
   * of exhausting it, and a staff appointment form makes that an ordinary Saturday. The
   * IP limit still applies, and a signed-in member of staff is accountable by name in the
   * audit log besides.
   */
  skipWhen: (req) => (req as { auth?: { kind?: string } }).auth?.kind === 'user',
  keyGenerator: (req) => {
    const body = req.body as { phone?: unknown };
    const phone = typeof body?.phone === 'string' ? normalizePhone(body.phone) : null;
    // The IP fallback goes through `ipKeyGenerator`, which normalises IPv6 to its /56
    // prefix. Keying on the raw address would give one person a fresh bucket per
    // address in their own prefix, which is the whole allocation.
    return phone ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
});

/**
 * Keyed on the device, not the address.
 *
 * The whole shop shares one IP, and this fires from a customer's own taps — an address
 * limit would let one tablet throttle the other. Generous on purpose: it exists for a
 * client stuck in a loop, not for somebody who cannot make their mind up. It sits before
 * the auth guard so an unpaired flood is limited too, which is why the key falls back to
 * the address when there is no device on the request.
 */
const quoteLimit = limiter({
  windowMs: 60_000,
  limit: 120,
  message: 'That screen is asking too quickly. It will catch up in a moment.',
  keyGenerator: (req) => {
    const auth = (req as { auth?: { kind?: string; deviceId?: string } }).auth;
    return auth?.kind === 'device' && auth.deviceId !== undefined
      ? `device:${auth.deviceId}`
      : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
});

// --- Reads -------------------------------------------------------------------

queueRouter.get('/queue', requireUser, async (_req, res) => {
  const body: QueueBoardDto = toQueueBoardDto(await getQueueBoard());
  res.json({ board: body });
});

/**
 * What this customer's chosen services would actually cost them in waiting, per barber.
 *
 * Not a widened board and not a flag on `POST /queue`, and both for the same reason: the
 * answer is a function of a selection only this tablet knows. The board is computed once
 * and broadcast to every screen, so it could only ever quote a service picked on the
 * customer's behalf — which is the shop-wide headline it already carries. And `POST
 * /queue` is a write, audited, broadcast, and limited per phone, so browsing barbers
 * would spend the join budget of a number they have not typed yet.
 *
 * `KIOSK` only. A wall display has no form and nothing to quote for.
 */
queueRouter.get('/queue/quote', quoteLimit, requireDevice('KIOSK'), async (req, res) => {
  const raw = req.query as Record<string, unknown>;
  // Parsed exactly as `GET /availability` does, so the two public reads that take a set
  // of services accept the same thing.
  const serviceIds =
    typeof raw.serviceIds === 'string'
      ? raw.serviceIds.split(',').filter(Boolean)
      : Array.isArray(raw.serviceIds)
        ? (raw.serviceIds as string[])
        : [];

  const query = walkInQuoteQuerySchema.parse({ serviceIds });
  const { board, durationMinutes } = await quoteWalkIn(query.serviceIds);

  const body: WalkInQuoteDto = toWalkInQuoteDto(board, query.serviceIds, durationMinutes);
  res.json({ quote: body });
});

/** Kiosk and wall display. No type restriction — both read the same redacted board. */
queueRouter.get('/queue/board', requireDevice(), async (_req, res) => {
  const body: PublicQueueBoardDto = toPublicQueueBoardDto(await getQueueBoard());
  res.json({ board: body });
});

// --- Joining -----------------------------------------------------------------

/**
 * Open to staff (adding someone at the desk) and to a paired kiosk (the client adding
 * themselves). One code path, so the estimator, the snapshotting and the duplicate
 * check cannot differ between the two.
 */
queueRouter.post('/queue', joinIpLimit, joinPhoneLimit, async (req, res) => {
  if (!req.auth) throw new UnauthenticatedError('You must be signed in to do that.');

  /**
   * A device may join somebody ONLY if it is a kiosk.
   *
   * `DISPLAY` is the wall board — read-only by definition, mounted out of reach, and
   * with nobody standing at it. Letting one write would mean the difference between the
   * two device types was a label rather than a permission. The check lives here rather
   * than as `requireDevice('KIOSK')` middleware because this route also serves staff,
   * who are not devices at all.
   */
  if (req.auth.kind === 'device' && req.auth.deviceType !== 'KIOSK') {
    throw new ForbiddenError('This screen cannot add people to the queue.');
  }

  const input = joinQueueRequestSchema.parse(req.body);
  const isStaff = req.auth.kind === 'user';

  const { entry, board } = await joinQueue({
    client: { phone: input.phone, firstName: input.firstName, lastName: input.lastName },
    serviceIds: input.serviceIds,
    barberId: input.barberId ?? null,
    source: isStaff ? 'STAFF' : 'KIOSK',
    notes: input.notes ?? null,
  });

  await recordAudit(auditContext(req), {
    action: 'queue.joined',
    entityType: 'QueueEntry',
    entityId: entry.id,
    after: {
      barberId: entry.barberId,
      durationMinutes: entry.durationMinutes,
      priceCentsTotal: entry.priceCentsTotal,
    },
  });

  // A kiosk must not be handed the staff board as a side effect of joining.
  res.status(201).json({
    entryId: entry.id,
    board: isStaff ? toQueueBoardDto(board) : toPublicQueueBoardDto(board),
  });
});

// --- Moving the line ---------------------------------------------------------

/**
 * Whose chair the caller is asking to act on, read raw so the guard can run before the
 * body is parsed. Same shape as `payments.ts` — an absent or non-string value becomes an
 * empty id, which no barber matches, so a malformed body is refused rather than waved past.
 */
const bodyBarberId = (req: Request): string => {
  const value: unknown = (req.body as { barberId?: unknown } | undefined)?.barberId;
  return typeof value === 'string' ? value : '';
};

/**
 * Calling somebody up is an act on one barber's chair, so it belongs to that barber.
 *
 * `requireUser` alone proved somebody was signed in and nothing about whose chair they
 * were reaching into — one barber could call the next client into another's chair, or
 * finish a cut in it. The same gap was found and closed on appointments
 * (`routes/booking.ts`); this is the queue's half of it. An admin still passes for anyone,
 * which is what keeps the desk able to run the floor.
 */
queueRouter.post(
  '/queue/call-next',
  requireBarberSelfOrAdmin(bodyBarberId),
  async (req, res) => {
    const { barberId } = callNextRequestSchema.parse(req.body);
    const result = await callNext(barberId);

    await recordAudit(auditContext(req), {
      action: 'queue.called',
      entityType: 'QueueEntry',
      entityId: result.entry.id,
      after: { barberId, status: result.entry.status },
    });

    respond(res, result);
  },
);

/**
 * The two moves that mean "this person is physically at my chair".
 *
 * Everything else this route can do — calling somebody up, putting them back in the line,
 * a no-show, removing a walk-in who left — is a move on the shared line, and belongs in
 * the same category as `/priority` below: any staff member may make it, and the audit row
 * says who did. Locking those as well would stop a barber removing a walk-in who had been
 * attached to another chair, and would half-apply `callSpecific` on the client, which
 * assigns through the open route and then calls through this one.
 */
const CHAIR_TRANSITIONS = new Set<string>(['IN_CHAIR', 'COMPLETED']);

/**
 * Seating and finishing belong to the barber whose chair it is.
 *
 * The owner is on the stored row rather than in the request, so this is the `assert` form
 * rather than middleware — the same shape `POST /appointments/:id/cancel` uses, and for
 * the same reason. It costs no extra query: the snapshot the audit row already needs
 * carries the barber.
 *
 * **An unclaimed walk-in is nobody's to own**, and cannot reach either locked transition
 * anyway — `updateQueueStatus` refuses to seat somebody with no barber attached, and
 * COMPLETED is only reachable from IN_CHAIR. The null check is written out regardless,
 * because that refusal is a validation and this is an authorization; neither should be
 * load-bearing for the other.
 */
queueRouter.patch('/queue/:entryId/status', requireUser, async (req, res) => {
  const entryId = pathParam(req, 'entryId');
  const { status } = updateQueueStatusRequestSchema.parse(req.body);

  const before = await snapshotBefore(entryId);
  if (CHAIR_TRANSITIONS.has(status) && before.barberId !== null) {
    assertBarberSelfOrAdmin(req, before.barberId);
  }

  const result = await updateQueueStatus(entryId, status as QueueStatus);

  await recordAudit(auditContext(req), {
    action: 'queue.status_changed',
    entityType: 'QueueEntry',
    entityId: entryId,
    before: { status: before.status },
    after: { status: result.entry.status },
  });

  respond(res, result);
});

/**
 * Any staff member can bump someone forward — a barber should not have to find the
 * owner to pull their regular up the line. Accountability comes from the audit row
 * carrying who did it and what it was before, not from the door being locked.
 */
queueRouter.patch('/queue/:entryId/priority', requireUser, async (req, res) => {
  const entryId = pathParam(req, 'entryId');
  const { priority } = setQueuePriorityRequestSchema.parse(req.body);

  const before = await snapshotBefore(entryId);
  const result = await setQueuePriority(entryId, priority);

  await recordAudit(auditContext(req), {
    action: 'queue.priority_changed',
    entityType: 'QueueEntry',
    entityId: entryId,
    before: { priority: before.priority },
    after: { priority: result.entry.priority },
  });

  respond(res, result);
});

queueRouter.patch('/queue/:entryId/barber', requireUser, async (req, res) => {
  const entryId = pathParam(req, 'entryId');
  const { barberId } = assignQueueBarberRequestSchema.parse(req.body);

  const before = await snapshotBefore(entryId);
  const result = await assignQueueBarber(entryId, barberId);

  await recordAudit(auditContext(req), {
    action: 'queue.barber_changed',
    entityType: 'QueueEntry',
    entityId: entryId,
    before: { barberId: before.barberId },
    after: { barberId: result.entry.barberId },
  });

  respond(res, result);
});

// --- Helpers -----------------------------------------------------------------

/**
 * Every mutation answers with the whole board.
 *
 * Moving one person renumbers everyone behind them and can move another barber's
 * estimate, so a single-row response would be stale before it was rendered.
 */
function respond(res: Response, result: QueueMutation): void {
  res.json({ entryId: result.entry.id, board: toQueueBoardDto(result.board) });
}

/** The before-state for the audit row, read before the mutation changes it. */
async function snapshotBefore(entryId: string) {
  const entry = await getQueueEntry(entryId);
  return {
    status: entry?.status ?? null,
    priority: entry?.priority ?? null,
    barberId: entry?.barberId ?? null,
  };
}
