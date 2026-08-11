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

import {
  PAYMENT_STATUS,
  PAYOUT_STATUS,
  PAYOUT_TYPE,
  type PayoutStatus as PayoutStatusValue,
} from '@francis/shared';
import type Stripe from 'stripe';

import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { stripe } from '../lib/stripe.js';
import { recordAudit } from './audit.js';
import { applyAccountUpdate } from './connect.js';

/**
 * Events we act on. Anything else is still recorded and acknowledged — see the note in
 * the route. Adding a type here is the only change needed to start handling it.
 */
const HANDLED = new Set<string>([
  'account.updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  // Not a status change — this is where the Stripe fee actually arrives. See below.
  'charge.updated',
  /**
   * All four, because a payout's whole life is worth having. `created` is also the ONLY
   * way an automatic daily payout enters this system — Stripe makes those on its own
   * schedule and we never call anything, so without this a barber's history would show
   * only the instant ones they pressed a button for.
   */
  'payout.created',
  'payout.updated',
  'payout.paid',
  'payout.failed',
]);

export function isHandledEventType(type: string): boolean {
  return HANDLED.has(type);
}

export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'account.updated':
      await onAccountUpdated(event);
      return;

    case 'payment_intent.succeeded':
      await onPaymentSucceeded(event);
      return;

    case 'payment_intent.payment_failed':
      await onPaymentFailed(event);
      return;

    case 'charge.updated':
      await onChargeUpdated(event);
      return;

    case 'payout.created':
    case 'payout.updated':
    case 'payout.paid':
    case 'payout.failed':
      await onPayout(event);
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

/**
 * The event that actually settles a card payment.
 *
 * **This, not the browser coming back.** A customer can close the tab on a successful
 * payment, lose signal, or pay on a phone that then locks — the redirect is a courtesy and
 * the webhook is the record. Everything that marks money as received happens here.
 *
 * Re-runnable: a row already `SUCCEEDED` returns immediately, so a redelivery neither
 * writes a second audit entry nor re-reads the balance transaction.
 */
async function onPaymentSucceeded(event: Stripe.PaymentIntentSucceededEvent): Promise<void> {
  const intent = event.data.object;

  const payment = await findPaymentByIntent(intent.id);
  if (payment === null) return;

  if (payment.status === PAYMENT_STATUS.SUCCEEDED) return;

  const settled = await settlePaymentFromIntent(payment.id, intent, event.account);

  await recordAudit(
    { principal: undefined, ipAddress: null },
    {
      action: 'payment.recorded',
      entityType: 'Payment',
      entityId: payment.id,
      after: {
        barberId: settled.barberId,
        method: settled.method,
        amountCents: settled.amountCents,
        tipCents: settled.tipCents,
        totalCents: settled.totalCents,
        stripeFeeCents: settled.stripeFeeCents,
        netCents: settled.netCents,
      },
    },
  );

  logger.info(
    { paymentId: payment.id, totalCents: settled.totalCents },
    'Card payment settled from webhook',
  );
}

/**
 * A declined card.
 *
 * The row stays `PENDING` rather than moving to `FAILED`, which looks wrong and is not.
 * The PaymentIntent survives a decline — the customer can pick another card and try again
 * on the same link — so releasing the ticket here would open a window where the barber,
 * seeing it settleable again, takes cash while the retry is still in flight. The failure
 * reason is recorded, and the barber cancels it if the customer gives up.
 */
async function onPaymentFailed(event: Stripe.PaymentIntentPaymentFailedEvent): Promise<void> {
  const intent = event.data.object;

  const payment = await findPaymentByIntent(intent.id);
  if (payment === null) return;
  if (payment.status !== PAYMENT_STATUS.PENDING) return;

  const reason =
    intent.last_payment_error?.message ?? intent.last_payment_error?.code ?? 'Card declined.';

  await prisma.payment.update({
    where: { id: payment.id },
    data: { failureReason: reason },
  });

  await recordAudit(
    { principal: undefined, ipAddress: null },
    {
      action: 'payment.failed',
      entityType: 'Payment',
      entityId: payment.id,
      after: { barberId: payment.barberId, failureReason: reason },
    },
  );
}

/**
 * Where the Stripe fee actually comes from.
 *
 * `payment_intent.succeeded` fires before the charge's balance transaction exists — the
 * money is taken, but what Stripe took for taking it is not computed yet. Verified live:
 * settling from the intent alone left `stripeFeeCents` null, and the same charge carried a
 * fee of 184 a second later.
 *
 * So the fee is backfilled from `charge.updated`, which is precisely the event Stripe
 * sends when the charge is finalised. It is a no-op once the figures are stored, so
 * repeated deliveries — and there are several per charge — cost one indexed read.
 */
async function onChargeUpdated(event: Stripe.ChargeUpdatedEvent): Promise<void> {
  const charge = event.data.object;

  const payment = await prisma.payment.findFirst({
    where: { stripeChargeId: charge.id },
    select: { id: true, stripeFeeCents: true },
  });

  if (payment === null || payment.stripeFeeCents !== null) return;

  const fees = await readFees(charge.balance_transaction, event.account, charge.id);
  if (fees === null) return;

  await prisma.payment.update({ where: { id: payment.id }, data: fees });

  logger.info(
    { paymentId: payment.id, stripeFeeCents: fees.stripeFeeCents, netCents: fees.netCents },
    'Stripe fee recorded',
  );
}

/**
 * Stripe's payout statuses, in our vocabulary. `canceled` keeps Stripe's spelling on their
 * side and ours on ours rather than pretending they are the same word.
 */
const PAYOUT_STATUS_BY_STRIPE: Record<string, PayoutStatusValue> = {
  pending: PAYOUT_STATUS.PENDING,
  in_transit: PAYOUT_STATUS.IN_TRANSIT,
  paid: PAYOUT_STATUS.PAID,
  failed: PAYOUT_STATUS.FAILED,
  canceled: PAYOUT_STATUS.CANCELED,
};

/**
 * A payout's entire life, from all four events.
 *
 * **Upsert, not update.** The daily automatic payout is created by Stripe with nothing on
 * our side calling anything, so the first this system hears of it is `payout.created` — and
 * that row has to be created here or it never exists. An instant payout, by contrast, was
 * already written by `createInstantPayout`, and these events only move it along.
 *
 * Which is also why `type` is only set on insert: an automatic payout is inferred from
 * having no row yet, and an existing INSTANT row must never be relabelled by a later event
 * that carries no such distinction.
 */
async function onPayout(
  event:
    | Stripe.PayoutCreatedEvent
    | Stripe.PayoutUpdatedEvent
    | Stripe.PayoutPaidEvent
    | Stripe.PayoutFailedEvent,
): Promise<void> {
  const payout = event.data.object;

  if (event.account === undefined) {
    // A payout on the platform's own account. Nothing here is a barber's money.
    logger.debug({ payout: payout.id }, 'payout event with no connected account');
    return;
  }

  const barber = await prisma.barber.findUnique({
    where: { stripeAccountId: event.account },
    select: { id: true },
  });

  if (barber === null) {
    logger.debug({ stripeAccount: event.account }, 'payout event for an unknown account');
    return;
  }

  const status = PAYOUT_STATUS_BY_STRIPE[payout.status] ?? PAYOUT_STATUS.PENDING;
  const arrivalDate = payout.arrival_date === null ? null : new Date(payout.arrival_date * 1000);
  const failureReason = payout.failure_message ?? null;

  const existing = await prisma.payout.findUnique({
    where: { stripePayoutId: payout.id },
    select: { id: true, feeCents: true, status: true },
  });

  /**
   * The real fee, at last — until now the row has carried our quote of Stripe's published
   * rate, and this is what Stripe actually took.
   *
   * Read on every event that carries a balance transaction, which is deliberately not
   * "only the first time we have no fee". An instant payout is written with a non-zero
   * quote, so a guard on "we already have a number" would keep the estimate forever and
   * quietly make the reconciliation this whole design rests on a no-op. Stripe only
   * populates `balance_transaction` once one exists, so this is naturally self-limiting,
   * and re-reading it yields the same figure.
   */
  const fees = await readFees(payout.balance_transaction, event.account, payout.id);

  /**
   * A reported zero does NOT overwrite what we already hold.
   *
   * Verified in the sandbox: an instant payout's balance transaction comes back with
   * `fee: 0` and empty `fee_details`, because test mode does not charge the instant fee.
   * Taking that literally replaced the $0.50 the barber had agreed to with $0.00 — a
   * history that contradicts the dialog they confirmed, in the direction that looks like
   * we forgot to charge them.
   *
   * Zero is ambiguous: it means "free" on the daily automatic payout and "not accounted
   * for here" on an instant one. A non-zero figure is unambiguous, so only that is allowed
   * to replace the quote. An automatic payout has no quote to protect — it is inserted at
   * zero and stays there.
   */
  const reportedFee = fees === null ? undefined : Math.abs(fees.stripeFeeCents);
  const feeCents = reportedFee === undefined || reportedFee === 0 ? undefined : reportedFee;

  const settled = status === PAYOUT_STATUS.PAID || status === PAYOUT_STATUS.FAILED;
  let changed: boolean;

  if (existing === null) {
    await prisma.payout.create({
      data: {
        barberId: barber.id,
        stripePayoutId: payout.id,
        amountCents: payout.amount,
        feeCents: feeCents ?? 0,
        currency: payout.currency.toUpperCase(),
        // No row means nobody here asked for it, which means Stripe's own schedule did.
        type: payout.method === 'instant' ? PAYOUT_TYPE.INSTANT : PAYOUT_TYPE.STANDARD_AUTO,
        status,
        arrivalDate,
        failureReason,
      },
    });
    changed = true;
  } else {
    // Details that may legitimately move on any event — an arrival estimate shifts, a fee
    // finally lands. Unconditional, because none of them is a transition.
    await prisma.payout.update({
      where: { id: existing.id },
      data: { arrivalDate, failureReason, ...(feeCents === undefined ? {} : { feeCents }) },
    });

    /**
     * The status change itself is decided by the database, not by what we read a moment
     * ago.
     *
     * Stripe sends several events per payout within the same second and more than one
     * carries `paid`; Express handles them concurrently, so two handlers can both read
     * `PENDING` before either writes and both then believe they made the transition.
     * Observed live: three `payout.paid` audit rows for two payouts. Guarding the update
     * on the old status makes exactly one of them win, whatever the interleaving.
     */
    const moved = await prisma.payout.updateMany({
      where: { id: existing.id, status: { not: status } },
      data: { status },
    });
    changed = moved.count > 0;
  }

  /**
   * Audited on the transition, not on the state — the trail is meant to record that money
   * arrived, once, not that four messages said so.
   */
  if (settled && changed) {
    await recordAudit(
      { principal: undefined, ipAddress: null },
      {
        action: status === PAYOUT_STATUS.PAID ? 'payout.paid' : 'payout.failed',
        entityType: 'Payout',
        entityId: payout.id,
        after: {
          barberId: barber.id,
          amountCents: payout.amount,
          feeCents: feeCents ?? existing?.feeCents ?? null,
          failureReason,
        },
      },
    );
  }
}

/**
 * Reads fee and net off a balance transaction, expanding it if the event only carried the
 * id. Returns null when it does not exist yet — which is normal, not an error.
 *
 * Takes the field rather than the object that owns it, because charges and payouts both
 * carry one in the same shape and both need the same answer. `ownerId` is only for the
 * log line, so a failure says which object it was reading for.
 */
async function readFees(
  balance: string | Stripe.BalanceTransaction | null,
  stripeAccount: string | undefined,
  ownerId: string,
): Promise<{ stripeFeeCents: number; netCents: number } | null> {
  if (balance === null) return null;

  if (typeof balance !== 'string') {
    return { stripeFeeCents: balance.fee, netCents: balance.net };
  }

  if (stripeAccount === undefined) return null;

  try {
    // Direct charges: the balance transaction lives on the barber's account, not ours.
    const resolved = await stripe().balanceTransactions.retrieve(balance, undefined, {
      stripeAccount,
    });
    return { stripeFeeCents: resolved.fee, netCents: resolved.net };
  } catch (error) {
    logger.warn({ err: error, ownerId }, 'Could not read the balance transaction');
    return null;
  }
}

async function findPaymentByIntent(intentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { stripePaymentIntentId: intentId },
  });

  if (payment === null) {
    // A sandbox accumulates intents from `stripe trigger` and other experiments, and every
    // one of them delivers here. Not ours is normal, not an error worth retrying.
    logger.debug({ intentId }, 'payment_intent event for an unknown intent');
  }

  return payment;
}

/**
 * Writes the settled figures.
 *
 * The fee is attempted here and usually is not available yet — see `onChargeUpdated`,
 * which backfills it. A missing fee is never a reason to hold up recording the payment:
 * the money moved either way, and the cost of moving it is a detail that arrives late.
 */
async function settlePaymentFromIntent(
  paymentId: string,
  intent: Stripe.PaymentIntent,
  stripeAccount: string | undefined,
) {
  const charge =
    typeof intent.latest_charge === 'string' ? null : (intent.latest_charge ?? null);
  const chargeId =
    typeof intent.latest_charge === 'string' ? intent.latest_charge : (charge?.id ?? null);

  const fees =
    charge === null ? null : await readFees(charge.balance_transaction, stripeAccount, charge.id);

  return prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: PAYMENT_STATUS.SUCCEEDED,
      paidAt: new Date(),
      stripeChargeId: chargeId,
      ...(fees ?? {}),
      failureReason: null,
      // The link is spent. It must stop resolving.
      checkoutTokenHash: null,
    },
  });
}
