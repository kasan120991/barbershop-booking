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
  /**
   * An appointment moved — a new time, a new chair, or both.
   *
   * Not a status change, so it does not fit `appointment.status_changed`, and
   * emphatically not a cancellation followed by a creation: the row keeps its id and its
   * cancel token, so the trail has to be able to say "this became that" rather than
   * leaving somebody to infer that two rows an hour apart were one haircut. `before` and
   * `after` carry the barber and the start, which is what a "but I booked it for two
   * o'clock" conversation actually needs.
   */
  | 'appointment.rescheduled'
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
  | 'device.deleted'
  /**
   * Stripe Connect onboarding. Not a money movement yet, but it is the act that decides
   * *which account money will land in* — so who created a chair's connected account, and
   * when Stripe cleared it to take payment, is exactly the trail a disputed payout needs.
   *
   * `connect.status_changed` is recorded only when a mirrored capability actually
   * changed. It is re-read on every return trip from onboarding, and logging the no-ops
   * would bury the two transitions anyone will ever look for.
   */
  | 'connect.account_created'
  | 'connect.status_changed'
  /**
   * Money changed hands. Cash especially: a card payment leaves a second copy of the
   * story on Stripe, and cash leaves none — this row is the only record that the drawer
   * and the day's total should agree, and who says so.
   */
  | 'payment.recorded'
  /**
   * The card half. `checkout_started` is not a money movement yet — it is the moment a
   * ticket stopped being settleable any other way, which is exactly what someone will be
   * asking about when a cut appears to have been paid for twice, or not at all.
   *
   * `payment.failed` is written from the webhook, so it has no actor. That is honest: a
   * decline is Stripe's answer, not anybody's action.
   */
  | 'payment.checkout_started'
  | 'payment.voided'
  | 'payment.failed'
  /**
   * Money leaving the barber's Stripe account for their bank.
   *
   * `payout.requested` has an actor — a barber decided to pay a fee to get their money
   * today. The other two come from webhooks and have none, which is honest: whether a
   * payout landed is Stripe's answer, not anybody's action. The automatic daily payout
   * is deliberately not audited on creation; nobody did anything, and a row per chair
   * per day would bury the ones somebody chose.
   */
  | 'payout.requested'
  | 'payout.paid'
  | 'payout.failed'
  /**
   * Booth rent — the money going the other way.
   *
   * Rent is settled offline, so unlike a card payment there is no second copy of the story
   * anywhere. These rows are the only record that a chair was charged, that cash changed
   * hands, and that somebody decided a debt would not be collected. `charge_waived` is the
   * one worth having most: it is the only action here that makes money owed stop being owed.
   *
   * A charge raised by the plan is deliberately NOT audited. It is arithmetic, it happens on
   * a schedule nobody triggers, and a row per chair per week would bury the three above.
   */
  | 'rent.plan_changed'
  | 'rent.charge_created'
  | 'rent.payment_recorded'
  | 'rent.charge_waived';

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
