/**
 * The webhook endpoint.
 *
 * These sign their own fixtures with the suite's `STRIPE_WEBHOOK_SECRET` (see
 * `vitest.config.ts`) and drive the real `constructEvent` path rather than stubbing past
 * it. Verification is the only thing standing between this route and an unauthenticated
 * POST that moves money, so a test that skips it tests nothing worth knowing.
 *
 * The redelivery case is the other one that earns its keep. Stripe retries on any
 * non-2xx and redelivers on its own schedule, so "runs twice" is the normal case, not
 * the edge one.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { stripe } from '../lib/stripe.js';
import { hashPassword } from '../services/passwords.js';
import { STRIPE_WEBHOOK_PATH } from './stripe-webhook.js';

const app = createApp();

// One listening server for the file — see the note in devices.test.ts.
const server = app.listen(0);
afterAll(() => {
  server.close();
});

const DOMAIN = '@webhook.test';
const EVENT_PREFIX = 'evt_whtest_';
const ACCOUNT_ID = 'acct_whtest_known';
const PAYMENT_ID = 'pay_whtest_1';

const passwordHash = await hashPassword('FrancisCutz!2026');

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

let barberId: string;

async function cleanup() {
  await prisma.webhookEvent.deleteMany({ where: { stripeEventId: { startsWith: EVENT_PREFIX } } });
  // Payments hold a required barberId, so they go before the barber they point at.
  await prisma.payment.deleteMany({ where: { barber: { user: { email: { contains: DOMAIN } } } } });
  // Audit rows are keyed by the entity they describe, so both entities have to be named —
  // the payment ones outlive the payment row and would otherwise accumulate across tests.
  await prisma.auditLog.deleteMany({
    where: { entityId: { in: [barberId ?? '', PAYMENT_ID] } },
  });
  await prisma.barber.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.user.deleteMany({ where: { email: { contains: DOMAIN } } });
}

async function seed() {
  await cleanup();

  const user = await prisma.user.create({
    data: {
      email: `ana${DOMAIN}`,
      passwordHash,
      firstName: 'Ana',
      lastName: 'Hook',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  const barber = await prisma.barber.create({
    data: {
      userId: user.id,
      displayName: 'Ana Hook',
      slug: `ana-hook-${user.id}`,
      stripeAccountId: ACCOUNT_ID,
      // Starts as an account Stripe has not cleared, so the event below is a real move.
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    },
  });

  barberId = barber.id;
}

interface AccountShape {
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  externalAccounts?: { object: string }[];
}

function accountUpdatedPayload(
  eventId: string,
  accountId = ACCOUNT_ID,
  account: AccountShape = {},
): string {
  return JSON.stringify({
    id: eventId,
    object: 'event',
    api_version: '2025-01-01',
    created: 1_760_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'account.updated',
    // Connected-account events carry this; it is what routes one to a barber.
    account: accountId,
    data: {
      object: {
        id: accountId,
        object: 'account',
        charges_enabled: account.charges_enabled ?? true,
        payouts_enabled: account.payouts_enabled ?? true,
        details_submitted: account.details_submitted ?? true,
        external_accounts: { object: 'list', data: account.externalAccounts ?? [] },
      },
    },
  });
}

function sign(payload: string): string {
  return stripe().webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET as string,
  });
}

function post(payload: string, signature: string) {
  return request(server)
    .post(STRIPE_WEBHOOK_PATH)
    .set('Content-Type', 'application/json')
    .set('stripe-signature', signature)
    .send(payload);
}

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('stripe webhook', () => {
  beforeEach(seed);

  it('refuses a body whose signature does not verify', async () => {
    const payload = accountUpdatedPayload(`${EVENT_PREFIX}bad`);

    await post(payload, 't=1,v1=deadbeef').expect(400);

    // Nothing recorded and nothing applied — a forged delivery leaves no trace but a log.
    expect(await prisma.webhookEvent.count({ where: { stripeEventId: `${EVENT_PREFIX}bad` } })).toBe(0);
    const barber = await prisma.barber.findUnique({ where: { id: barberId } });
    expect(barber?.chargesEnabled).toBe(false);
  });

  it('refuses a request with no signature at all', async () => {
    const payload = accountUpdatedPayload(`${EVENT_PREFIX}nosig`);

    await request(server)
      .post(STRIPE_WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(400);
  });

  /**
   * A body that verifies against a *different* payload proves the check is over the
   * bytes, not merely over the presence of a well-formed header.
   */
  it('refuses a signature computed for a different body', async () => {
    const signed = accountUpdatedPayload(`${EVENT_PREFIX}one`);
    const tampered = accountUpdatedPayload(`${EVENT_PREFIX}two`);

    await post(tampered, sign(signed)).expect(400);
  });

  it('applies account.updated to the barber it belongs to', async () => {
    const eventId = `${EVENT_PREFIX}ok`;
    const payload = accountUpdatedPayload(eventId, ACCOUNT_ID, {
      externalAccounts: [{ object: 'card' }],
    });

    const response = await post(payload, sign(payload)).expect(200);
    expect(response.body).toMatchObject({ received: true, handled: true });

    const barber = await prisma.barber.findUnique({ where: { id: barberId } });
    expect(barber?.chargesEnabled).toBe(true);
    expect(barber?.payoutsEnabled).toBe(true);
    expect(barber?.detailsSubmitted).toBe(true);
    // A debit card on the account is what makes Instant Payout possible at all.
    expect(barber?.instantPayoutEligible).toBe(true);

    const record = await prisma.webhookEvent.findUnique({ where: { stripeEventId: eventId } });
    expect(record?.processedAt).not.toBeNull();
    expect(record?.stripeAccount).toBe(ACCOUNT_ID);

    const audits = await prisma.auditLog.count({
      where: { entityId: barberId, action: 'connect.status_changed' },
    });
    expect(audits).toBe(1);
  });

  /** The case Stripe actually produces: the same event, delivered again. */
  it('is idempotent on redelivery', async () => {
    const eventId = `${EVENT_PREFIX}dupe`;
    const payload = accountUpdatedPayload(eventId);
    const signature = sign(payload);

    await post(payload, signature).expect(200);
    const second = await post(payload, signature).expect(200);

    expect(second.body).toMatchObject({ received: true, duplicate: true });
    expect(await prisma.webhookEvent.count({ where: { stripeEventId: eventId } })).toBe(1);
    // The second delivery must not re-audit a change that already happened.
    expect(
      await prisma.auditLog.count({
        where: { entityId: barberId, action: 'connect.status_changed' },
      }),
    ).toBe(1);
  });

  /**
   * Answering an unhandled type with an error earns the same event back every few hours
   * for days. It is recorded either way, so adding a handler later is a replay rather
   * than a guess about what was missed.
   */
  it('acknowledges an event type it does not handle', async () => {
    const eventId = `${EVENT_PREFIX}other`;
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      api_version: '2025-01-01',
      created: 1_760_000_000,
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: 'payout.paid',
      account: ACCOUNT_ID,
      data: { object: { id: 'po_test', object: 'payout' } },
    });

    const response = await post(payload, sign(payload)).expect(200);
    expect(response.body).toMatchObject({ received: true, handled: false });

    const record = await prisma.webhookEvent.findUnique({ where: { stripeEventId: eventId } });
    expect(record?.type).toBe('payout.paid');
    expect(record?.processedAt).not.toBeNull();
  });

  /**
   * A platform sandbox accumulates accounts from `stripe trigger` and from other
   * experiments, and every one of them delivers here. Not knowing the account is normal,
   * not an error worth retrying.
   */
  it('acknowledges an account it holds no barber for', async () => {
    const eventId = `${EVENT_PREFIX}unknown`;
    const payload = accountUpdatedPayload(eventId, 'acct_whtest_stranger');

    await post(payload, sign(payload)).expect(200);

    const barber = await prisma.barber.findUnique({ where: { id: barberId } });
    expect(barber?.chargesEnabled).toBe(false);
  });
});

/**
 * Settling a card payment.
 *
 * This is what actually marks money as received — not the browser coming back, which a
 * customer can skip entirely by closing the tab. Every fixture below sets
 * `latest_charge: null` so the handler takes no network trip for the balance transaction;
 * the fee is verified live instead, against a real sandbox charge.
 */
describe.skipIf(!reachable)('payment_intent events', () => {
  const INTENT_ID = 'pi_whtest_1';

  beforeEach(async () => {
    await seed();
    await prisma.payment.create({
      data: {
        id: PAYMENT_ID,
        barberId,
        method: 'CARD_ONLINE',
        status: 'PENDING',
        amountCents: 4500,
        tipCents: 810,
        totalCents: 5310,
        stripeAccountId: ACCOUNT_ID,
        stripePaymentIntentId: INTENT_ID,
        checkoutTokenHash: 'whtest-token-hash',
      },
    });
  });

  function intentPayload(eventId: string, type: string, intentId = INTENT_ID, extra = {}): string {
    return JSON.stringify({
      id: eventId,
      object: 'event',
      api_version: '2025-01-01',
      created: 1_760_000_000,
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type,
      account: ACCOUNT_ID,
      data: {
        object: {
          id: intentId,
          object: 'payment_intent',
          amount: 5310,
          currency: 'usd',
          // Null so the handler does not reach for a balance transaction over the network.
          latest_charge: null,
          ...extra,
        },
      },
    });
  }

  it('settles the payment', async () => {
    const payload = intentPayload(`${EVENT_PREFIX}paid`, 'payment_intent.succeeded');

    const response = await post(payload, sign(payload)).expect(200);
    expect(response.body).toMatchObject({ handled: true });

    const payment = await prisma.payment.findUnique({ where: { id: PAYMENT_ID } });
    expect(payment?.status).toBe('SUCCEEDED');
    expect(payment?.paidAt).not.toBeNull();
    // The link is spent and must stop resolving.
    expect(payment?.checkoutTokenHash).toBeNull();

    const audits = await prisma.auditLog.count({
      where: { entityId: PAYMENT_ID, action: 'payment.recorded' },
    });
    expect(audits).toBe(1);
  });

  it('is idempotent when the same success is delivered twice', async () => {
    const payload = intentPayload(`${EVENT_PREFIX}paid2`, 'payment_intent.succeeded');
    const signature = sign(payload);

    await post(payload, signature).expect(200);
    const second = await post(payload, signature).expect(200);

    expect(second.body).toMatchObject({ duplicate: true });
    expect(
      await prisma.auditLog.count({
        where: { entityId: PAYMENT_ID, action: 'payment.recorded' },
      }),
    ).toBe(1);
  });

  /**
   * A *different* event id carrying the same success — which Stripe does produce — must
   * also not double-count. The `WebhookEvent` row cannot help here; the handler's own
   * status check is what does.
   */
  it('does not re-settle a payment that is already succeeded', async () => {
    const first = intentPayload(`${EVENT_PREFIX}paidA`, 'payment_intent.succeeded');
    const again = intentPayload(`${EVENT_PREFIX}paidB`, 'payment_intent.succeeded');

    await post(first, sign(first)).expect(200);
    await post(again, sign(again)).expect(200);

    expect(
      await prisma.auditLog.count({
        where: { entityId: PAYMENT_ID, action: 'payment.recorded' },
      }),
    ).toBe(1);
  });

  /**
   * A decline leaves the row PENDING on purpose. The intent survives it — the customer
   * can try another card on the same link — so releasing the ticket here would let the
   * barber take cash while a retry is still in flight.
   */
  it('records a decline without releasing the ticket', async () => {
    const payload = intentPayload(`${EVENT_PREFIX}declined`, 'payment_intent.payment_failed', INTENT_ID, {
      last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
    });

    await post(payload, sign(payload)).expect(200);

    const payment = await prisma.payment.findUnique({ where: { id: PAYMENT_ID } });
    expect(payment?.status).toBe('PENDING');
    expect(payment?.failureReason).toBe('Your card was declined.');
    // Still resolvable, so the customer can try another card on the same link.
    expect(payment?.checkoutTokenHash).not.toBeNull();
  });

  /**
   * The fee arrives after the money does.
   *
   * Verified live: settling from `payment_intent.succeeded` alone left `stripeFeeCents`
   * null, and the same charge carried a fee a few seconds later on `charge.updated`. The
   * balance transaction is expanded in this fixture so the handler takes no network trip.
   */
  it('backfills the Stripe fee from charge.updated', async () => {
    const chargeId = 'ch_whtest_1';
    await prisma.payment.update({
      where: { id: PAYMENT_ID },
      data: { status: 'SUCCEEDED', stripeChargeId: chargeId },
    });

    const payload = JSON.stringify({
      id: `${EVENT_PREFIX}fee`,
      object: 'event',
      api_version: '2025-01-01',
      created: 1_760_000_000,
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: 'charge.updated',
      account: ACCOUNT_ID,
      data: {
        object: {
          id: chargeId,
          object: 'charge',
          balance_transaction: { id: 'txn_whtest_1', object: 'balance_transaction', fee: 184, net: 5126 },
        },
      },
    });

    await post(payload, sign(payload)).expect(200);

    const payment = await prisma.payment.findUnique({ where: { id: PAYMENT_ID } });
    expect(payment?.stripeFeeCents).toBe(184);
    // What actually reaches the barber, and what their payout is made of.
    expect(payment?.netCents).toBe(5126);
  });

  /** Several `charge.updated` land per charge; only the first has anything to do. */
  it('leaves an already-recorded fee alone', async () => {
    const chargeId = 'ch_whtest_2';
    await prisma.payment.update({
      where: { id: PAYMENT_ID },
      data: { status: 'SUCCEEDED', stripeChargeId: chargeId, stripeFeeCents: 100, netCents: 5210 },
    });

    const payload = JSON.stringify({
      id: `${EVENT_PREFIX}fee2`,
      object: 'event',
      api_version: '2025-01-01',
      created: 1_760_000_000,
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: 'charge.updated',
      account: ACCOUNT_ID,
      data: {
        object: {
          id: chargeId,
          object: 'charge',
          balance_transaction: { id: 'txn_whtest_2', object: 'balance_transaction', fee: 999, net: 1 },
        },
      },
    });

    await post(payload, sign(payload)).expect(200);

    const payment = await prisma.payment.findUnique({ where: { id: PAYMENT_ID } });
    expect(payment?.stripeFeeCents).toBe(100);
  });

  it('acknowledges an intent it holds no payment for', async () => {
    const payload = intentPayload(`${EVENT_PREFIX}stranger`, 'payment_intent.succeeded', 'pi_not_ours');

    await post(payload, sign(payload)).expect(200);

    const payment = await prisma.payment.findUnique({ where: { id: PAYMENT_ID } });
    expect(payment?.status).toBe('PENDING');
  });
});
