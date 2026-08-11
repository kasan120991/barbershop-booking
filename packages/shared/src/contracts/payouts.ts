/**
 * Payout contracts — a barber getting at their own money.
 *
 * Card money lives in the barber's own Stripe account, never the shop's, so everything
 * here describes one chair's balance and one chair's payouts. There is no shop-wide view
 * to build because there is no shop-wide balance to view.
 *
 * Two payout types, and the difference matters to whoever is reading:
 *
 * - `STANDARD_AUTO` is the free daily payout Stripe makes on its own schedule. Nobody
 *   presses anything; these appear in the history because the webhook puts them there.
 * - `INSTANT` is a barber deciding they want it now and paying Stripe's fee for it.
 */

import { z } from 'zod';

import { PAYOUT_STATUS, PAYOUT_TYPE } from '../enums.js';

export const payoutTypeSchema = z.enum(Object.values(PAYOUT_TYPE) as [string, ...string[]]);
export const payoutStatusSchema = z.enum(Object.values(PAYOUT_STATUS) as [string, ...string[]]);

/**
 * What Stripe is holding for this chair.
 *
 * Three numbers rather than one because they answer different questions. `available` is
 * settled and payable on the normal schedule; `pending` is money taken but still inside
 * Stripe's rolling window; `instantAvailable` is what could be moved *right now* — which
 * deliberately includes pending card funds, since that is the entire point of an instant
 * payout.
 *
 * Carries no Stripe account id. A barber does not need it to read their own balance, and
 * a response that does not contain it cannot leak it.
 */
export const balanceDtoSchema = z.object({
  availableCents: z.int(),
  pendingCents: z.int(),
  /**
   * **The eligibility signal, not just an amount.** Stripe reports zero here for an
   * account that cannot take an instant payout at all, which is a more honest gate than
   * inspecting external accounts ourselves — a US bank account can be instant-eligible
   * even though it is not a debit card.
   */
  instantAvailableCents: z.int(),
  currency: z.string(),
});
export type BalanceDto = z.infer<typeof balanceDtoSchema>;

export const payoutDtoSchema = z.object({
  id: z.string(),
  type: payoutTypeSchema,
  status: payoutStatusSchema,
  amountCents: z.int().nonnegative(),
  /** Zero on an automatic payout — the daily one is free. */
  feeCents: z.int().nonnegative(),
  currency: z.string(),
  /** Stripe's estimate of when it lands. Moves; `payout.updated` is mostly about this. */
  arrivalDate: z.iso.datetime().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type PayoutDto = z.infer<typeof payoutDtoSchema>;

/**
 * What a chair took today, split the way a barber counts it.
 *
 * Cash and card are separated because they arrive differently: the cash is already in
 * their pocket, the card is what Stripe is holding. Adding them into one number would
 * describe a figure nobody is waiting for.
 */
export const earningsSummaryDtoSchema = z.object({
  date: z.string(),
  cutCount: z.int().nonnegative(),
  cashCents: z.int().nonnegative(),
  cardCents: z.int().nonnegative(),
  tipsCents: z.int().nonnegative(),
  totalCents: z.int().nonnegative(),
});
export type EarningsSummaryDto = z.infer<typeof earningsSummaryDtoSchema>;

/**
 * Stripe's published Instant Payout pricing for the US.
 *
 * These live in `shared` because the confirm dialog and the server must quote the same
 * number — a fee shown to somebody and a fee charged to them differing by a cent is the
 * kind of thing that costs trust rather than money.
 *
 * There is no API that will tell us the fee in advance; the real figure only lands on the
 * payout's balance transaction afterwards. So this is the published rate, quoted honestly
 * as a rate, and reconciled from the webhook once it is known.
 */
export const INSTANT_FEE_BPS = 150;
export const INSTANT_FEE_MIN_CENTS = 50;
export const INSTANT_PAYOUT_MIN_CENTS = 50;
export const INSTANT_PAYOUT_MAX_CENTS = 999_900;

/**
 * The fee for an instant payout of this amount, by Stripe's published formula.
 *
 * Shared rather than server-only so the dialog does not compute its own version. Rounds
 * half away from zero, like `percentOfCents`, and never returns less than the floor — a
 * $10 cash-out costs fifty cents, not fifteen.
 */
export function instantPayoutFeeCents(amountCents: number): number {
  const proportional = Math.round((amountCents * INSTANT_FEE_BPS) / 10_000);
  return Math.max(INSTANT_FEE_MIN_CENTS, proportional);
}

export const instantPayoutQuoteDtoSchema = z.object({
  amountCents: z.int().nonnegative(),
  feeCents: z.int().nonnegative(),
  /** What actually lands in the bank. The number the barber is deciding about. */
  netCents: z.int().nonnegative(),
});
export type InstantPayoutQuoteDto = z.infer<typeof instantPayoutQuoteDtoSchema>;

export const createInstantPayoutRequestSchema = z.object({
  amountCents: z
    .int()
    .min(INSTANT_PAYOUT_MIN_CENTS)
    .max(INSTANT_PAYOUT_MAX_CENTS),
});
export type CreateInstantPayoutRequest = z.infer<typeof createInstantPayoutRequestSchema>;
