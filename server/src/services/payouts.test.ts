/**
 * The instant payout quote, and the guards around cashing out.
 *
 * The quote is the number a barber is looking at when they decide to give up 1.5% of their
 * day to have it now, so it gets tested at every boundary Stripe defines. It is pure and
 * touches nothing, which is most of why it was worth extracting.
 *
 * The refusals matter for the opposite reason: each one is a request Stripe would reject
 * anyway, and catching it here means the barber gets a sentence instead of a 500.
 */

import {
  INSTANT_FEE_MIN_CENTS,
  INSTANT_PAYOUT_MAX_CENTS,
  instantPayoutFeeCents,
} from '@francis/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../lib/prisma.js';
import { hashPassword } from './passwords.js';
import { createInstantPayout, getEarningsSummary, quoteInstantPayout } from './payouts.js';

describe('quoteInstantPayout', () => {
  it('takes 1.5% of an ordinary cash-out', () => {
    // $200.00 → $3.00, leaving $197.00.
    expect(quoteInstantPayout(20_000)).toEqual({
      amountCents: 20_000,
      feeCents: 300,
      netCents: 19_700,
    });
  });

  /**
   * The floor is the case that would embarrass us. 1.5% of $10 is fifteen cents, and a
   * barber shown fifteen cents who is charged fifty has been misled about the one number
   * they were asked to agree to.
   */
  it('never charges less than the fifty cent floor', () => {
    expect(quoteInstantPayout(1_000)).toEqual({
      amountCents: 1_000,
      feeCents: INSTANT_FEE_MIN_CENTS,
      netCents: 950,
    });
  });

  /** Exactly where the proportional fee overtakes the floor: 1.5% of $33.34 is 50.01c. */
  it('crosses over from the floor to the percentage at the right point', () => {
    expect(instantPayoutFeeCents(3_333)).toBe(INSTANT_FEE_MIN_CENTS);
    expect(instantPayoutFeeCents(3_334)).toBe(50);
    expect(instantPayoutFeeCents(3_400)).toBe(51);
  });

  it('handles the maximum Stripe will pay out instantly', () => {
    const quote = quoteInstantPayout(INSTANT_PAYOUT_MAX_CENTS);
    expect(quote.feeCents).toBe(14_999);
    expect(quote.netCents).toBe(INSTANT_PAYOUT_MAX_CENTS - 14_999);
  });

  /** Money is integer cents everywhere; a fee that rounds to a fraction is a bug. */
  it('always returns whole cents', () => {
    for (const amount of [101, 999, 1_234, 7_777, 65_432]) {
      expect(Number.isInteger(instantPayoutFeeCents(amount))).toBe(true);
    }
  });
});

// --- Database-backed guards ---------------------------------------------------

const DOMAIN = '@payouts.test';
const passwordHash = await hashPassword('FrancisCutz!2026');

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

let barberId: string;
let staffUserId: string;

async function cleanup() {
  const scope = { barber: { user: { email: { contains: DOMAIN } } } };
  await prisma.payout.deleteMany({ where: scope });
  await prisma.payment.deleteMany({ where: scope });
  await prisma.barber.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.user.deleteMany({ where: { email: { contains: DOMAIN } } });
}

async function seed(connect: { payoutsEnabled?: boolean; account?: boolean } = {}) {
  await cleanup();

  const user = await prisma.user.create({
    data: {
      email: `ana${DOMAIN}`,
      passwordHash,
      firstName: 'Ana',
      lastName: 'Payout',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });
  staffUserId = user.id;

  const barber = await prisma.barber.create({
    data: {
      userId: user.id,
      displayName: 'Ana',
      slug: `ana-${user.id}`,
      ...(connect.account === false
        ? {}
        : { stripeAccountId: `acct_paytest_${user.id}`, chargesEnabled: true }),
      payoutsEnabled: connect.payoutsEnabled ?? true,
    },
  });
  barberId = barber.id;
}

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

/**
 * Every case below is refused before any Stripe call, which is what makes them testable
 * without a sandbox — and what stops a barber waiting on a network round trip to be told
 * something we already knew.
 */
describe.skipIf(!reachable)('createInstantPayout refusals', () => {
  beforeEach(() => seed());

  it('refuses a chair with no connected account', async () => {
    await seed({ account: false });

    await expect(
      createInstantPayout({ barberId, amountCents: 5_000, initiatedByUserId: staffUserId }),
    ).rejects.toThrow(/has not finished payout setup/i);
  });

  it('refuses a chair Stripe will not pay out from', async () => {
    await seed({ payoutsEnabled: false });

    await expect(
      createInstantPayout({ barberId, amountCents: 5_000, initiatedByUserId: staffUserId }),
    ).rejects.toThrow(/cannot pay out from this chair/i);
  });

  it('refuses an amount below what Stripe will send', async () => {
    await expect(
      createInstantPayout({ barberId, amountCents: 10, initiatedByUserId: staffUserId }),
    ).rejects.toThrow(/not an amount stripe will pay out/i);
  });

  it('refuses an amount above the per-payout maximum', async () => {
    await expect(
      createInstantPayout({
        barberId,
        amountCents: INSTANT_PAYOUT_MAX_CENTS + 1,
        initiatedByUserId: staffUserId,
      }),
    ).rejects.toThrow(/not an amount stripe will pay out/i);
  });

  it('refuses a fractional amount', async () => {
    await expect(
      createInstantPayout({ barberId, amountCents: 100.5, initiatedByUserId: staffUserId }),
    ).rejects.toThrow(/not an amount stripe will pay out/i);
  });

  it('writes no payout row when it refuses', async () => {
    await seed({ payoutsEnabled: false });

    await expect(
      createInstantPayout({ barberId, amountCents: 5_000, initiatedByUserId: staffUserId }),
    ).rejects.toThrow();

    expect(await prisma.payout.count({ where: { barberId } })).toBe(0);
  });
});

describe.skipIf(!reachable)('getEarningsSummary', () => {
  beforeEach(() => seed());

  /**
   * Cash and card stay apart because they are in different places — the cash is already
   * in the barber's pocket, the card is what Stripe is holding and what a payout moves.
   */
  it('splits the day by how the money arrived, and counts tips once', async () => {
    const common = { barberId, currency: 'USD', paidAt: new Date() } as const;

    await prisma.payment.createMany({
      data: [
        { ...common, method: 'CASH', status: 'SUCCEEDED', amountCents: 4_500, tipCents: 500, totalCents: 5_000 },
        { ...common, method: 'CARD_ONLINE', status: 'SUCCEEDED', amountCents: 2_000, tipCents: 400, totalCents: 2_400 },
        // Neither of these is money: one never completed, one was called off.
        { ...common, method: 'CARD_ONLINE', status: 'PENDING', amountCents: 9_900, tipCents: 0, totalCents: 9_900 },
        { ...common, method: 'CARD_ONLINE', status: 'VOIDED', amountCents: 8_800, tipCents: 0, totalCents: 8_800 },
      ],
    });

    const summary = await getEarningsSummary(barberId);

    expect(summary.cutCount).toBe(2);
    expect(summary.cashCents).toBe(5_000);
    expect(summary.cardCents).toBe(2_400);
    expect(summary.tipsCents).toBe(900);
    expect(summary.totalCents).toBe(7_400);
  });

  it('reads zero for a chair that has taken nothing', async () => {
    const summary = await getEarningsSummary(barberId);
    expect(summary).toMatchObject({ cutCount: 0, cashCents: 0, cardCents: 0, totalCents: 0 });
  });
});
