/**
 * The Stripe webhook endpoint.
 *
 * Mounted directly on the app rather than inside `apiRouter`, and **before**
 * `express.json` — signature verification hashes the exact bytes Stripe sent, and a body
 * that has been parsed and re-serialised is no longer those bytes. See `app.ts`.
 *
 * Sitting that early also means it runs before `cookieParser`, `authenticate` and
 * `verifyCsrf`. All three are correct to skip: the signature *is* the authentication,
 * there is no principal behind a Stripe delivery, and CSRF protects a browser with an
 * ambient cookie — which this is not.
 *
 * This module owns two things and delegates the rest: proving the request came from
 * Stripe, and making sure a redelivery cannot run a handler twice.
 */

import express, { type RequestHandler } from 'express';

import { API_PREFIX, WEBHOOK_BODY_LIMIT } from '../config/constants.js';
import { env } from '../config/env.js';
import { InternalError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { stripe } from '../lib/stripe.js';
import { handleStripeEvent, isHandledEventType } from '../services/webhooks.js';

export const STRIPE_WEBHOOK_PATH = `${API_PREFIX}/stripe/webhook`;

/**
 * Raw body, not JSON. `type` is narrowed to what Stripe actually sends so this parser
 * cannot accidentally swallow anything else that reaches the same path.
 */
// Annotated rather than inferred: `express.raw` returns a type from `@types/connect`,
// which tsc cannot name from here under this workspace layout.
export const stripeWebhookParser: RequestHandler = express.raw({
  type: 'application/json',
  limit: WEBHOOK_BODY_LIMIT,
});

export const stripeWebhookHandler: RequestHandler = async (req, res) => {
  const secret = env.STRIPE_WEBHOOK_SECRET;

  // Unconfigured means CLOSED. Falling back to trusting the body would turn this into an
  // unauthenticated POST that moves money, which is worse than being down.
  if (secret === undefined) {
    throw new InternalError('STRIPE_WEBHOOK_SECRET is not set — refusing webhook delivery.');
  }

  const signature = req.header('stripe-signature');
  if (signature === undefined) throw new ValidationError('Missing signature.');

  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body as Buffer, signature, secret);
  } catch (error) {
    // Logged in full, answered in one word. The verification failure message names the
    // scheme and timestamp tolerance, and a caller who cannot sign has no use for either.
    logger.warn({ err: error }, 'Stripe webhook signature verification failed');
    throw new ValidationError('Invalid signature.');
  }

  /**
   * Idempotency, in two parts.
   *
   * The unique `stripeEventId` stops a redelivery inserting twice. But acking on the row
   * *existing* would be wrong: an attempt that died mid-handler leaves `processedAt`
   * null, and treating that as "already seen" would drop the event permanently — the one
   * case retries exist for. So the ack is on `processedAt`, and anything unstamped runs
   * again.
   */
  const existing = await prisma.webhookEvent.findUnique({
    where: { stripeEventId: event.id },
  });

  if (existing?.processedAt != null) {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  const record =
    existing ??
    (await prisma.webhookEvent
      .create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          // Present on connected-account events; this is what routes one to a barber.
          stripeAccount: event.account ?? null,
          payload: event as unknown as object,
        },
      })
      // Two deliveries of the same event racing: the loser takes the row the winner just
      // wrote rather than failing the delivery.
      .catch(async () => {
        const found = await prisma.webhookEvent.findUnique({
          where: { stripeEventId: event.id },
        });
        if (found === null) throw new InternalError('Could not record webhook event.');
        return found;
      }));

  if (record.processedAt != null) {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  try {
    await handleStripeEvent(event);
  } catch (error) {
    // Persist why, then let it 500 so Stripe retries. `processedAt` stays null, which is
    // what makes the retry actually re-run rather than being acked as a duplicate.
    await prisma.webhookEvent
      .update({
        where: { id: record.id },
        data: { error: error instanceof Error ? error.message : String(error) },
      })
      .catch(() => undefined);

    throw error;
  }

  await prisma.webhookEvent.update({
    where: { id: record.id },
    data: { processedAt: new Date(), error: null },
  });

  /**
   * An unhandled type is still a 200.
   *
   * Stripe retries any non-2xx with backoff, so answering "I don't handle this" with an
   * error earns the same event every few hours forever. It is recorded either way, which
   * is what makes adding a handler later a matter of replaying rows rather than guessing
   * what was missed.
   */
  res.status(200).json({ received: true, handled: isHandledEventType(event.type) });
};
