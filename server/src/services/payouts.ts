/**
 * Getting a barber their money.
 *
 * Card takings sit in the barber's own Stripe account and leave it by one of two routes:
 * the free automatic payout Stripe makes daily, or an instant one the barber asks for and
 * pays a fee on. Only the second is initiated here — the first is Stripe acting on its own
 * schedule, and it reaches this system through `payout.*` webhooks rather than through any
 * call we make.
 *
 * That asymmetry is worth holding on to: **this module is not the source of the payout
 * history.** It starts instant payouts and reads balances; the webhook is what makes the
 * table complete.
 */

import {
  INSTANT_PAYOUT_MAX_CENTS,
  INSTANT_PAYOUT_MIN_CENTS,
  PAYMENT_METHOD,
  PAYOUT_STATUS,
  PAYOUT_TYPE,
  instantPayoutFeeCents,
  type InstantPayoutQuoteDto,
} from '@francis/shared';

import { DateTime } from 'luxon';

import type { PayoutModel } from '../generated/prisma/models.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { stripe } from '../lib/stripe.js';
import { getShopSettings } from './catalog.js';
import { listPaymentsForShopDay } from './payments.js';

/** USD only — single location, one currency, per the locked decisions. */
const CURRENCY = 'usd';

export interface BarberBalance {
  availableCents: number;
  pendingCents: number;
  instantAvailableCents: number;
  currency: string;
}

async function connectedAccountOf(barberId: string): Promise<{
  stripeAccountId: string;
  payoutsEnabled: boolean;
}> {
  const barber = await prisma.barber.findUnique({
    where: { id: barberId },
    select: { stripeAccountId: true, payoutsEnabled: true },
  });

  if (!barber) throw new NotFoundError('Barber not found.');
  if (barber.stripeAccountId === null) {
    throw new ConflictError('This chair has not finished payout setup yet.');
  }

  return { stripeAccountId: barber.stripeAccountId, payoutsEnabled: barber.payoutsEnabled };
}

/** Sums one currency's entries out of a Stripe balance array. */
function sumFor(entries: { amount: number; currency: string }[] | undefined): number {
  return (entries ?? [])
    .filter((entry) => entry.currency === CURRENCY)
    .reduce((total, entry) => total + entry.amount, 0);
}

/**
 * What Stripe is holding for this chair, read live.
 *
 * Not mirrored into our database on purpose. A balance is true for as long as it takes to
 * read it — a cached one is a number that used to be right, and this is the figure someone
 * decides to move money against.
 */
export async function getBalance(barberId: string): Promise<BarberBalance> {
  const { stripeAccountId } = await connectedAccountOf(barberId);

  const balance = await stripe().balance.retrieve(undefined, { stripeAccount: stripeAccountId });

  return {
    availableCents: sumFor(balance.available),
    pendingCents: sumFor(balance.pending),
    // Absent entirely on an account Stripe will not pay out instantly, which is exactly
    // the "not eligible" answer — so zero is the right reading of a missing field.
    instantAvailableCents: sumFor(balance.instant_available ?? undefined),
    currency: CURRENCY,
  };
}

/**
 * The quote a barber is shown before they commit.
 *
 * Pure, and it delegates the arithmetic to `shared` so the dialog cannot compute a
 * different number than the server does. Stripe has no endpoint that will price a payout
 * in advance; this is their published rate applied honestly, and the webhook later writes
 * the fee Stripe actually took.
 */
export function quoteInstantPayout(amountCents: number): InstantPayoutQuoteDto {
  const feeCents = instantPayoutFeeCents(amountCents);
  return { amountCents, feeCents, netCents: amountCents - feeCents };
}

export interface CreateInstantPayoutInput {
  barberId: string;
  amountCents: number;
  initiatedByUserId: string;
}

/**
 * Moves money now, for a fee.
 *
 * The guards run in the order a person would ask them: is this chair set up, is the amount
 * sane, and is there actually that much available *instantly* — which is a different and
 * smaller number than the balance, and the one Stripe will refuse against.
 */
export async function createInstantPayout(input: CreateInstantPayoutInput): Promise<PayoutModel> {
  const { stripeAccountId, payoutsEnabled } = await connectedAccountOf(input.barberId);

  if (!payoutsEnabled) {
    throw new ConflictError('Stripe cannot pay out from this chair yet. Add a payout method.');
  }

  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents < INSTANT_PAYOUT_MIN_CENTS ||
    input.amountCents > INSTANT_PAYOUT_MAX_CENTS
  ) {
    throw new ValidationError('That is not an amount Stripe will pay out instantly.');
  }

  const balance = await getBalance(input.barberId);

  if (balance.instantAvailableCents <= 0) {
    throw new ConflictError('There is nothing available to cash out right now.');
  }

  if (input.amountCents > balance.instantAvailableCents) {
    throw new ConflictError('That is more than is available to cash out right now.');
  }

  const quote = quoteInstantPayout(input.amountCents);

  const payout = await stripe().payouts.create(
    { amount: input.amountCents, currency: CURRENCY, method: 'instant' },
    {
      stripeAccount: stripeAccountId,
      /**
       * Two taps on Cash Out must not send the money twice. Keyed on the chair, the amount
       * and the minute — the same request repeated is one payout, while a barber genuinely
       * cashing out the same amount again a while later is a different one.
       */
      idempotencyKey: `instant-${input.barberId}-${String(input.amountCents)}-${String(
        Math.floor(Date.now() / 60_000),
      )}`,
    },
  );

  /**
   * The fee stored here is the QUOTE, not Stripe's figure — theirs does not exist yet. The
   * `payout.paid` webhook overwrites it from the balance transaction. Recording the quote
   * rather than zero means the history is never briefly wrong in the barber's favour.
   */
  return prisma.payout.create({
    data: {
      barberId: input.barberId,
      stripePayoutId: payout.id,
      amountCents: payout.amount,
      feeCents: quote.feeCents,
      currency: CURRENCY.toUpperCase(),
      type: PAYOUT_TYPE.INSTANT,
      status: PAYOUT_STATUS.PENDING,
      arrivalDate: payout.arrival_date === null ? null : new Date(payout.arrival_date * 1000),
      initiatedByUserId: input.initiatedByUserId,
    },
  });
}

/** Both kinds, newest first — the automatic ones arrived here by webhook. */
export async function listPayouts(barberId: string, limit = 20): Promise<PayoutModel[]> {
  return prisma.payout.findMany({
    where: { barberId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export interface EarningsSummary {
  date: string;
  cutCount: number;
  cashCents: number;
  cardCents: number;
  tipsCents: number;
  totalCents: number;
}

/**
 * What this chair took today, split by how it arrived.
 *
 * Built on `listPaymentsForShopDay` rather than a second day-range query, so "today" means
 * the same thing here as it does on the Take Payment screen — the shop's day, resolved
 * server-side, not the browser's.
 *
 * Cash and card stay apart because they are in different places: the cash is in the
 * barber's pocket already, the card is what Stripe is holding and what a payout moves.
 */
export async function getEarningsSummary(
  barberId: string,
  localDate?: string,
): Promise<EarningsSummary> {
  const payments = await listPaymentsForShopDay(barberId, localDate);

  /**
   * Say which day this is about, resolved the same way the query was.
   *
   * Echoing back an empty string when the caller omitted the date would make the reply
   * unusable for a heading — and the client must not fill that gap in itself, because its
   * idea of today is its own machine's, not the shop's.
   */
  const { timezone } = await getShopSettings();
  const date = localDate ?? DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');

  const settled = payments.filter((payment) => payment.status === 'SUCCEEDED');

  const cashCents = settled
    .filter((payment) => payment.method === PAYMENT_METHOD.CASH)
    .reduce((total, payment) => total + payment.totalCents, 0);

  const cardCents = settled
    .filter((payment) => payment.method !== PAYMENT_METHOD.CASH)
    .reduce((total, payment) => total + payment.totalCents, 0);

  return {
    date,
    cutCount: settled.length,
    cashCents,
    cardCents,
    tipsCents: settled.reduce((total, payment) => total + payment.tipCents, 0),
    totalCents: cashCents + cardCents,
  };
}
