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

const passwordHash = await hashPassword('FrancisCutz!2026');

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

let barberId: string;

async function cleanup() {
  await prisma.webhookEvent.deleteMany({ where: { stripeEventId: { startsWith: EVENT_PREFIX } } });
  if (barberId !== undefined) {
    await prisma.auditLog.deleteMany({ where: { entityId: barberId } });
  }
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
