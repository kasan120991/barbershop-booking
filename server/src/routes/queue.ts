/**
 * The walk-in queue.
 *
 * Two boards, two audiences. `/queue` is the staff board and carries phone numbers;
 * `/queue/board` is what a paired kiosk or wall display reads, and is redacted by
 * construction in the mapper rather than by omission here.
 *
 * Joining is the only route in the file open to a device. Everything that moves the
 * line — calling, seating, reordering — is staff-only, and because `req.auth` is a
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
  type PublicQueueBoardDto,
  type QueueBoardDto,
} from '@francis/shared';
import { Router, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { isTest } from '../config/env.js';
import type { QueueStatus } from '../generated/prisma/enums.js';
import { UnauthenticatedError } from '../lib/errors.js';
import { pathParam } from '../lib/http.js';
import { toPublicQueueBoardDto, toQueueBoardDto } from '../mappers/queue.js';
import { requireDevice, requireUser } from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import {
  assignQueueBarber,
  callNext,
  getQueueBoard,
  getQueueEntry,
  joinQueue,
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
const joinIpLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
});

const joinPhoneLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  keyGenerator: (req) => {
    const body = req.body as { phone?: unknown };
    const phone = typeof body?.phone === 'string' ? normalizePhone(body.phone) : null;
    // The IP fallback goes through `ipKeyGenerator`, which normalises IPv6 to its /56
    // prefix. Keying on the raw address would give one person a fresh bucket per
    // address in their own prefix, which is the whole allocation.
    return phone ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
});

// --- Reads -------------------------------------------------------------------

queueRouter.get('/queue', requireUser, async (_req, res) => {
  const body: QueueBoardDto = toQueueBoardDto(await getQueueBoard());
  res.json({ board: body });
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

queueRouter.post('/queue/call-next', requireUser, async (req, res) => {
  const { barberId } = callNextRequestSchema.parse(req.body);
  const result = await callNext(barberId);

  await recordAudit(auditContext(req), {
    action: 'queue.called',
    entityType: 'QueueEntry',
    entityId: result.entry.id,
    after: { barberId, status: result.entry.status },
  });

  respond(res, result);
});

queueRouter.patch('/queue/:entryId/status', requireUser, async (req, res) => {
  const entryId = pathParam(req, 'entryId');
  const { status } = updateQueueStatusRequestSchema.parse(req.body);

  const before = await snapshotBefore(entryId);
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
