/**
 * Recording cash.
 *
 * The tests that matter here are the refusals. Recording a payment that should have been
 * recorded is the easy half; what costs the shop real money is a cut charged twice, a
 * ticket paid at a price nobody agreed, or a barber's takings landing on somebody else's
 * rent.
 */

import { PAYMENT_STATUS } from '@francis/shared';
import { DateTime } from 'luxon';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../lib/prisma.js';
import { hashPassword } from './passwords.js';
import {
  getCheckoutByToken,
  listPayableTickets,
  recordCashPayment,
  startCardCheckout,
  voidPayment,
} from './payments.js';

const DOMAIN = '@payments.test';
const PHONE = '+15555550701';
const SERVICE_NAME = 'PAYTEST Fade';

const passwordHash = await hashPassword('FrancisCutz!2026');

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

async function cleanup() {
  const barberScope = { barber: { user: { email: { contains: DOMAIN } } } };

  await prisma.payment.deleteMany({ where: barberScope });
  await prisma.queueEntryService.deleteMany({ where: { queueEntry: barberScope } });
  await prisma.queueEntry.deleteMany({ where: barberScope });
  await prisma.appointmentService.deleteMany({ where: { appointment: barberScope } });
  await prisma.appointment.deleteMany({ where: barberScope });
  await prisma.client.deleteMany({ where: { phoneE164: { startsWith: '+1555555070' } } });
  await prisma.barberService.deleteMany({ where: { service: { name: SERVICE_NAME } } });
  await prisma.service.deleteMany({ where: { name: SERVICE_NAME } });
  await prisma.barber.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.user.deleteMany({ where: { email: { contains: DOMAIN } } });
}

async function makeBarber(name: string, connect: { chargesEnabled?: boolean } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `${name.toLowerCase()}${DOMAIN}`,
      passwordHash,
      firstName: name,
      lastName: 'Pay',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  return prisma.barber.create({
    data: {
      userId: user.id,
      displayName: name,
      slug: `${name.toLowerCase()}-${user.id}`,
      // Only set when the test needs a chair Stripe has cleared; `startCardCheckout`
      // refuses everything else.
      ...(connect.chargesEnabled === true
        ? { stripeAccountId: `acct_paytest_${user.id}`, chargesEnabled: true }
        : {}),
    },
  });
}

/** The live price. Snapshots are taken from it and then deliberately drift apart below. */
const LIVE_PRICE = 4000;

let barberId: string;
let otherBarberId: string;
let clientId: string;
let serviceId: string;
let staffUserId: string;

async function seed() {
  await cleanup();

  const barber = await makeBarber('Ana');
  const other = await makeBarber('Ben');
  barberId = barber.id;
  otherBarberId = other.id;
  staffUserId = barber.userId;

  const client = await prisma.client.create({
    data: { phoneE164: PHONE, firstName: 'Cash', lastName: 'Client' },
  });
  clientId = client.id;

  const service = await prisma.service.create({
    data: { name: SERVICE_NAME, priceCents: LIVE_PRICE, durationMinutes: 40 },
  });
  serviceId = service.id;
}

/** A walk-in already in the chair — the normal moment cash is handed over. */
async function seatedWalkIn(
  overrides: { barberId?: string; status?: string; completedAt?: Date } = {},
) {
  return prisma.queueEntry.create({
    data: {
      clientId,
      barberId: overrides.barberId ?? barberId,
      status: (overrides.status ?? 'IN_CHAIR') as 'IN_CHAIR',
      ...(overrides.completedAt === undefined ? {} : { completedAt: overrides.completedAt }),
      durationMinutes: 40,
      priceCentsTotal: LIVE_PRICE,
      services: {
        create: [
          { serviceId, priceCents: LIVE_PRICE, durationMinutes: 40, nameSnapshot: SERVICE_NAME },
        ],
      },
    },
  });
}

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('recordCashPayment', () => {
  beforeEach(seed);

  it('records the cut and the tip, and sums them', async () => {
    const entry = await seatedWalkIn();

    const payment = await recordCashPayment({
      barberId,
      queueEntryId: entry.id,
      tipCents: 700,
      recordedByUserId: staffUserId,
    });

    expect(payment.method).toBe('CASH');
    expect(payment.status).toBe(PAYMENT_STATUS.SUCCEEDED);
    expect(payment.amountCents).toBe(LIVE_PRICE);
    expect(payment.tipCents).toBe(700);
    expect(payment.totalCents).toBe(LIVE_PRICE + 700);
    expect(payment.paidAt).not.toBeNull();
    // Nothing was processed, so there is no fee and no Stripe object.
    expect(payment.stripePaymentIntentId).toBeNull();
    expect(payment.stripeFeeCents).toBeNull();
  });

  /**
   * The reason prices are snapshotted at booking time at all. Editing the menu must not
   * rewrite what a cut already sold for — a barber who raises their fade to $60 at noon
   * has not thereby raised this morning's takings.
   */
  it('charges the snapshotted price, not the current menu price', async () => {
    const entry = await seatedWalkIn();
    await prisma.service.update({ where: { id: serviceId }, data: { priceCents: 9999 } });

    const payment = await recordCashPayment({
      barberId,
      queueEntryId: entry.id,
      tipCents: 0,
      recordedByUserId: staffUserId,
    });

    expect(payment.amountCents).toBe(LIVE_PRICE);
  });

  it('refuses a second payment for the same cut', async () => {
    const entry = await seatedWalkIn();
    const first = {
      barberId,
      queueEntryId: entry.id,
      tipCents: 0,
      recordedByUserId: staffUserId,
    };

    await recordCashPayment(first);
    await expect(recordCashPayment(first)).rejects.toThrow(/already been paid/i);

    const rows = await prisma.payment.count({ where: { queueEntryId: entry.id } });
    expect(rows).toBe(1);
  });

  /**
   * "Pay after service only" is a locked decision. Charging someone who is still in the
   * line is a deposit whatever it is called.
   */
  it('refuses a walk-in who is still waiting', async () => {
    const entry = await seatedWalkIn({ status: 'WAITING' });

    await expect(
      recordCashPayment({
        barberId,
        queueEntryId: entry.id,
        tipCents: 0,
        recordedByUserId: staffUserId,
      }),
    ).rejects.toThrow(/cannot be paid for yet/i);
  });

  /**
   * Rent is settled off these numbers, so a ticket cannot be booked onto a chair that
   * did not cut it — even by an admin, who passes the route guard for everyone.
   */
  it("refuses a ticket belonging to a different barber", async () => {
    const entry = await seatedWalkIn({ barberId: otherBarberId });

    await expect(
      recordCashPayment({
        barberId,
        queueEntryId: entry.id,
        tipCents: 0,
        recordedByUserId: staffUserId,
      }),
    ).rejects.toThrow(/different barber/i);

    expect(await prisma.payment.count({ where: { queueEntryId: entry.id } })).toBe(0);
  });

  it('refuses a request naming neither a booking nor a walk-in', async () => {
    await expect(
      recordCashPayment({ barberId, tipCents: 0, recordedByUserId: staffUserId }),
    ).rejects.toThrow(/exactly one/i);
  });

  it('refuses an unknown ticket', async () => {
    await expect(
      recordCashPayment({
        barberId,
        queueEntryId: 'cl-does-not-exist',
        tipCents: 0,
        recordedByUserId: staffUserId,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

/**
 * The list behind the Take Payment screen.
 *
 * Its whole job is the subtraction — "what still owes money", not "what happened today".
 * Get that wrong and the barber is back to comparing the screen against their own memory,
 * which is the work the screen exists to remove.
 */
describe.skipIf(!reachable)('listPayableTickets', () => {
  beforeEach(seed);

  /** Today in the shop's own timezone, which is the boundary the query uses. */
  const today = (): string =>
    DateTime.now().setZone('America/New_York').toFormat('yyyy-MM-dd');

  it('lists a finished walk-in that nobody has been paid for', async () => {
    const entry = await seatedWalkIn({ status: 'COMPLETED', completedAt: new Date() });

    const tickets = await listPayableTickets(barberId, today());

    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      kind: 'WALK_IN',
      id: entry.id,
      amountCents: LIVE_PRICE,
      clientFirstName: 'Cash',
    });
    expect(tickets[0]?.serviceNames).toEqual([SERVICE_NAME]);
  });

  it('drops a ticket the moment it is paid for', async () => {
    const entry = await seatedWalkIn({ status: 'COMPLETED', completedAt: new Date() });

    expect(await listPayableTickets(barberId, today())).toHaveLength(1);

    await recordCashPayment({
      barberId,
      queueEntryId: entry.id,
      tipCents: 0,
      recordedByUserId: staffUserId,
    });

    // The row disappearing is the confirmation that the payment landed.
    expect(await listPayableTickets(barberId, today())).toHaveLength(0);
  });

  it("never shows another barber's chair", async () => {
    await seatedWalkIn({ barberId: otherBarberId, status: 'COMPLETED', completedAt: new Date() });

    expect(await listPayableTickets(barberId, today())).toHaveLength(0);
    expect(await listPayableTickets(otherBarberId, today())).toHaveLength(1);
  });

  /** The cut about to be paid for is the one still in the chair, so it sorts first. */
  it('puts whoever is still in the chair above finished cuts', async () => {
    const finished = await seatedWalkIn({ status: 'COMPLETED', completedAt: new Date() });
    const inChair = await seatedWalkIn();

    const tickets = await listPayableTickets(barberId, today());

    expect(tickets.map((ticket) => ticket.id)).toEqual([inChair.id, finished.id]);
    expect(tickets[0]?.finishedAt).toBeNull();
  });

  it('does not list someone who is still waiting in the line', async () => {
    await seatedWalkIn({ status: 'WAITING' });

    expect(await listPayableTickets(barberId, today())).toHaveLength(0);
  });
});

/**
 * Opening a card checkout.
 *
 * None of this touches Stripe — the PaymentIntent is created later, when the customer has
 * chosen a tip — so the guards are all testable directly. They are also the whole point:
 * a QR that cannot work, or a cut charged twice, both start here.
 */
describe.skipIf(!reachable)('startCardCheckout', () => {
  beforeEach(seed);

  const today = (): string =>
    DateTime.now().setZone('America/New_York').toFormat('yyyy-MM-dd');

  /** `seed` builds Ana without a Stripe account; this gives her a cleared one. */
  async function clearedChair() {
    await prisma.barber.update({
      where: { id: barberId },
      data: { stripeAccountId: `acct_paytest_${barberId}`, chargesEnabled: true },
    });
  }

  it('refuses a chair Stripe has not cleared', async () => {
    const entry = await seatedWalkIn();

    await expect(
      startCardCheckout({ barberId, queueEntryId: entry.id, startedByUserId: staffUserId }),
    ).rejects.toThrow(/cannot take card payments yet/i);

    // Nothing created — a refused checkout must not leave a row blocking the ticket.
    expect(await prisma.payment.count({ where: { queueEntryId: entry.id } })).toBe(0);
  });

  it('opens a pending payment and returns a token exactly once', async () => {
    await clearedChair();
    const entry = await seatedWalkIn();

    const started = await startCardCheckout({
      barberId,
      queueEntryId: entry.id,
      startedByUserId: staffUserId,
    });

    expect(started.amountCents).toBe(LIVE_PRICE);
    expect(started.checkoutToken).toHaveLength(43);

    const payment = await prisma.payment.findUnique({ where: { id: started.paymentId } });
    expect(payment?.status).toBe(PAYMENT_STATUS.PENDING);
    expect(payment?.method).toBe('CARD_ONLINE');
    expect(payment?.tipCents).toBe(0);
    // Only the hash is stored — the plaintext never goes to the database.
    expect(payment?.checkoutTokenHash).not.toBeNull();
    expect(payment?.checkoutTokenHash).not.toBe(started.checkoutToken);
  });

  /** The window this closes: the customer is fetching their phone, the barber takes cash. */
  it('refuses cash while a card checkout is open', async () => {
    await clearedChair();
    const entry = await seatedWalkIn();

    await startCardCheckout({ barberId, queueEntryId: entry.id, startedByUserId: staffUserId });

    await expect(
      recordCashPayment({
        barberId,
        queueEntryId: entry.id,
        tipCents: 0,
        recordedByUserId: staffUserId,
      }),
    ).rejects.toThrow(/card payment is already waiting/i);
  });

  it('refuses a second checkout on the same cut', async () => {
    await clearedChair();
    const entry = await seatedWalkIn();

    const input = { barberId, queueEntryId: entry.id, startedByUserId: staffUserId };
    await startCardCheckout(input);

    await expect(startCardCheckout(input)).rejects.toThrow(/already waiting/i);
    expect(await prisma.payment.count({ where: { queueEntryId: entry.id } })).toBe(1);
  });

  /**
   * The ticket stays listed while a card is pending — annotated, not hidden. Hiding it
   * would remove the only route to the Cancel action.
   */
  it('keeps the ticket on the list, annotated', async () => {
    await clearedChair();
    const entry = await seatedWalkIn();

    const started = await startCardCheckout({
      barberId,
      queueEntryId: entry.id,
      startedByUserId: staffUserId,
    });

    const tickets = await listPayableTickets(barberId, today());
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.pendingPayment).toEqual({
      id: started.paymentId,
      totalCents: LIVE_PRICE,
    });
  });

  it('shows the payer the cut but never the client', async () => {
    await clearedChair();
    const entry = await seatedWalkIn();

    const started = await startCardCheckout({
      barberId,
      queueEntryId: entry.id,
      startedByUserId: staffUserId,
    });

    const view = await getCheckoutByToken(started.checkoutToken);

    expect(view.barberName).toBe('Ana');
    expect(view.serviceNames).toEqual([SERVICE_NAME]);
    expect(view.amountCents).toBe(LIVE_PRICE);
    // The link gets forwarded. Nothing about the person who had the cut is on it.
    expect(JSON.stringify(view)).not.toContain('Cash');
    expect(JSON.stringify(view)).not.toContain('Client');
  });

  it('refuses an unknown token with the same answer as a wrong one', async () => {
    await expect(getCheckoutByToken('not-a-real-token')).rejects.toThrow(/not valid/i);
  });

  it('releases the ticket when the barber cancels', async () => {
    await clearedChair();
    const entry = await seatedWalkIn();

    const started = await startCardCheckout({
      barberId,
      queueEntryId: entry.id,
      startedByUserId: staffUserId,
    });

    const voided = await voidPayment(started.paymentId);
    expect(voided.status).toBe(PAYMENT_STATUS.VOIDED);
    // A dead link must stop resolving.
    expect(voided.checkoutTokenHash).toBeNull();

    // And the cut can now be settled the other way.
    const cash = await recordCashPayment({
      barberId,
      queueEntryId: entry.id,
      tipCents: 0,
      recordedByUserId: staffUserId,
    });
    expect(cash.status).toBe(PAYMENT_STATUS.SUCCEEDED);
  });

  it('refuses to void a payment that is not waiting on a card', async () => {
    const entry = await seatedWalkIn();
    const cash = await recordCashPayment({
      barberId,
      queueEntryId: entry.id,
      tipCents: 0,
      recordedByUserId: staffUserId,
    });

    await expect(voidPayment(cash.id)).rejects.toThrow(/still waiting on a card/i);
  });
});
