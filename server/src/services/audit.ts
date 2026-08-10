/**
 * The audit trail.
 *
 * `AuditLog` has existed since the schema landed and nothing wrote to it until now.
 * The standing rule is that every money movement, queue reorder, appointment status
 * change and role change is recorded — this is the one function all of those go
 * through, so the shape stays consistent and the later phases have nothing to invent.
 *
 * Two deliberate properties:
 *
 * - **Never throws.** An audit write failing must not fail the thing being audited.
 *   A price change that succeeded but could not be logged is a gap in the record; a
 *   price change rolled back because the log was full is an outage.
 * - **Records the actor, whoever they are.** A kiosk device has no user, so the
 *   principal is a union and both halves are stored.
 */

import type { Request } from 'express';

import type { AuthPrincipal } from '../middleware/authenticate.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

/**
 * `entityType.verb`, past tense — `service.created`, `payment.refunded`.
 * A closed union rather than free strings, so the log stays queryable.
 */
export type AuditAction =
  | 'service.created'
  | 'service.updated'
  | 'service.archived'
  | 'service.restored'
  | 'service.deleted'
  | 'service.barbers_changed'
  | 'shop_settings.updated'
  | 'shop_hours.replaced'
  | 'shop_closure.created'
  | 'shop_closure.deleted'
  | 'barber.created'
  | 'barber.updated'
  | 'barber_schedule.replaced'
  | 'schedule_exception.created'
  | 'schedule_exception.deleted'
  | 'appointment.created'
  | 'appointment.cancelled'
  | 'appointment.status_changed'
  | 'queue.joined'
  | 'queue.called'
  | 'queue.status_changed'
  // The two reorders. Any staff member may make them, so the record of who did it
  // and what it was before is what keeps that accountable.
  | 'queue.priority_changed'
  | 'queue.barber_changed'
  /**
   * The credential lifecycle of a screen. Issuing one hands out queue access to a
   * tablet nobody signs into, so who did it and when is the only accountability there
   * is — the device itself can never be asked.
   *
   * `device.deleted` additionally carries the label, because it destroys the row:
   * `actorDeviceId` on every queue join a kiosk made is a bare id with no foreign key,
   * so without that snapshot those rows become unattributable.
   */
  | 'device.created'
  | 'device.revoked'
  | 'device.deleted';

export interface AuditInput {
  action: AuditAction;
  entityType: string;
  entityId: string;
  /** State before the change; omitted on creation. */
  before?: unknown;
  /** State after the change; omitted on deletion. */
  after?: unknown;
}

/** Extracts actor and IP from a request, so route handlers pass one argument. */
export function auditContext(req: Request) {
  return { principal: req.auth, ipAddress: req.ip ?? null };
}

export interface AuditContext {
  principal: AuthPrincipal | undefined;
  ipAddress: string | null;
}

/**
 * Round-trips through JSON so a Prisma model (which carries `Date` objects) becomes
 * something the Json column accepts, and so the snapshot is a genuine copy rather
 * than a reference that could still be mutated.
 */
function toJson(value: unknown): object {
  return JSON.parse(JSON.stringify(value)) as object;
}

export async function recordAudit(context: AuditContext, input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        actorUserId: context.principal?.kind === 'user' ? context.principal.userId : null,
        actorDeviceId: context.principal?.kind === 'device' ? context.principal.deviceId : null,
        // Spread rather than `before: undefined` — `exactOptionalPropertyTypes` treats
        // an explicit undefined as a real value, and Prisma's Json input rejects it.
        ...(input.before === undefined ? {} : { before: toJson(input.before) }),
        ...(input.after === undefined ? {} : { after: toJson(input.after) }),
        ipAddress: context.ipAddress,
      },
    });
  } catch (error) {
    // Logged, not thrown — see the note above.
    logger.error({ err: error, action: input.action, entityId: input.entityId }, 'Audit write failed');
  }
}
