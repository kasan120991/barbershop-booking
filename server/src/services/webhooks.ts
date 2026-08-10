/**
 * Stripe webhook handling.
 *
 * A plain function over a already-verified `Stripe.Event` — signature checking is the
 * route's job, because it needs the raw body and the request header. Keeping the two
 * apart is what lets these tests construct events directly instead of signing fixtures,
 * and it is the same split every other service here uses.
 *
 * **Everything arrives here twice eventually.** Stripe retries on any non-2xx and
 * redelivers on its own schedule, so a handler that is not safe to run again is a bug
 * waiting for a bad afternoon. The `WebhookEvent` row is the guard, and the route owns
 * it; each handler below is additionally written to be re-runnable on its own.
 */

import type Stripe from 'stripe';

import { logger } from '../lib/logger.js';
import { recordAudit } from './audit.js';
import { applyAccountUpdate } from './connect.js';

/**
 * Events we act on. Anything else is still recorded and acknowledged — see the note in
 * the route. Adding a type here is the only change needed to start handling it.
 */
const HANDLED = new Set<string>(['account.updated']);

export function isHandledEventType(type: string): boolean {
  return HANDLED.has(type);
}

export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'account.updated':
      await onAccountUpdated(event);
      return;

    default:
      // Recorded by the caller, deliberately not an error. See the route.
      return;
  }
}

/**
 * The event that keeps the capability mirror honest.
 *
 * Audited only on a real change. This fires on edits we do not mirror at all — a barber
 * changing their statement descriptor, Stripe re-running a check — and an audit row per
 * delivery would bury the two transitions anyone will ever go looking for.
 *
 * The audit actor is nobody: `recordAudit` takes a principal and there is no user or
 * device behind a webhook. That is honest, and it is exactly what distinguishes a change
 * Stripe made from one an admin made.
 */
async function onAccountUpdated(event: Stripe.AccountUpdatedEvent): Promise<void> {
  const account = event.data.object;

  const result = await applyAccountUpdate(account);

  if (result === null) {
    logger.debug({ stripeAccount: account.id }, 'account.updated for an unknown account');
    return;
  }

  if (!result.changed) return;

  await recordAudit(
    { principal: undefined, ipAddress: null },
    {
      action: 'connect.status_changed',
      entityType: 'Barber',
      entityId: result.barberId,
      before: result.before,
      after: result.after,
    },
  );

  logger.info(
    { barberId: result.barberId, state: result.after.state },
    'Connect capabilities updated from webhook',
  );
}
