/**
 * Who may see and touch a chair's Stripe account.
 *
 * This is the boundary that keeps one barber out of another's earnings, and it is worth
 * more coverage than the happy path: `stripeAccountId` identifies the account every cut
 * that chair sells is paid into.
 *
 * `GET /connect` is the only route here that does not call Stripe, which is exactly why
 * the authorization tests hang off it — they assert the guard without needing a live
 * platform key. The two Stripe-calling routes share the identical
 * `requireBarberSelfOrAdmin` middleware, so the guard under test is the same one.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_HEADER, DEVICE_TOKEN_HEADER } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';
import { hashToken } from '../lib/tokens.js';
import { hashPassword } from '../services/passwords.js';

const app = createApp();

// One listening server for the file — see the note in devices.test.ts.
const server = app.listen(0);
afterAll(() => {
  server.close();
});

const PASSWORD = 'FrancisCutz!2026';
const DOMAIN = '@connect.test';
const ADMIN_EMAIL = `admin${DOMAIN}`;
const ANA_EMAIL = `ana${DOMAIN}`;
const BEN_EMAIL = `ben${DOMAIN}`;

// argon2 is memory-hard: hash once for the file rather than per fixture.
const passwordHash = await hashPassword(PASSWORD);

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

const scope = { user: { email: { contains: DOMAIN } } };

async function cleanup() {
  await prisma.device.deleteMany({ where: { label: { startsWith: 'CONNTEST ' } } });
  await prisma.barber.deleteMany({ where: scope });
  await prisma.session.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.user.deleteMany({ where: { email: { contains: DOMAIN } } });
}

async function makeBarber(email: string, displayName: string, connect?: {
  stripeAccountId?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
}) {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: displayName,
      lastName: 'Test',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  return prisma.barber.create({
    data: {
      userId: user.id,
      displayName,
      slug: `${displayName.toLowerCase()}-${user.id}`,
      ...connect,
    },
  });
}

async function reseed() {
  await cleanup();

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash,
      firstName: 'Connect',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });
}

async function signIn(email: string) {
  const response = await request(server)
    .post('/api/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  return {
    cookies: response.headers['set-cookie'] as unknown as string[],
    csrfToken: response.body.csrfToken as string,
  };
}

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('connect status access', () => {
  beforeEach(reseed);

  it('lets a barber read their own chair', async () => {
    const ana = await makeBarber(ANA_EMAIL, 'Ana');
    const session = await signIn(ANA_EMAIL);

    const response = await request(server)
      .get(`/api/barbers/${ana.id}/connect`)
      .set('Cookie', session.cookies)
      .expect(200);

    expect(response.body).toMatchObject({
      barberId: ana.id,
      stripeAccountId: null,
      state: 'NOT_STARTED',
      chargesEnabled: false,
      payoutsEnabled: false,
    });
  });

  /** The one that matters. Ana must never learn where Ben's money goes. */
  it("refuses one barber another barber's chair", async () => {
    await makeBarber(ANA_EMAIL, 'Ana');
    const ben = await makeBarber(BEN_EMAIL, 'Ben', { stripeAccountId: 'acct_ben_private' });
    const session = await signIn(ANA_EMAIL);

    const response = await request(server)
      .get(`/api/barbers/${ben.id}/connect`)
      .set('Cookie', session.cookies)
      .expect(403);

    expect(JSON.stringify(response.body)).not.toContain('acct_ben_private');
  });

  it('lets an admin read any chair — the owner also runs the shop', async () => {
    const ben = await makeBarber(BEN_EMAIL, 'Ben', {
      stripeAccountId: 'acct_ben_1',
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
    const session = await signIn(ADMIN_EMAIL);

    const response = await request(server)
      .get(`/api/barbers/${ben.id}/connect`)
      .set('Cookie', session.cookies)
      .expect(200);

    expect(response.body.state).toBe('READY');
    expect(response.body.payoutsEnabled).toBe(true);
  });

  it('reports PENDING when details are in but Stripe has not cleared charges', async () => {
    const ana = await makeBarber(ANA_EMAIL, 'Ana', {
      stripeAccountId: 'acct_ana_1',
      detailsSubmitted: true,
    });
    const session = await signIn(ANA_EMAIL);

    const response = await request(server)
      .get(`/api/barbers/${ana.id}/connect`)
      .set('Cookie', session.cookies)
      .expect(200);

    expect(response.body.state).toBe('PENDING');
    expect(response.body.chargesEnabled).toBe(false);
  });

  it('refuses an unauthenticated request', async () => {
    const ana = await makeBarber(ANA_EMAIL, 'Ana');
    await request(server).get(`/api/barbers/${ana.id}/connect`).expect(401);
  });

  /**
   * A kiosk is a permission, not a label. Its token is narrow by design — queue and
   * board only — and payment setup is exactly the kind of thing a screen standing
   * unattended in the shop must never reach.
   */
  it('refuses a paired kiosk device', async () => {
    const ana = await makeBarber(ANA_EMAIL, 'Ana');

    const deviceToken = 'conntest-device-token';
    await prisma.device.create({
      data: {
        label: 'CONNTEST Front counter',
        type: 'KIOSK',
        tokenHash: hashToken(deviceToken),
        pairedAt: new Date(),
      },
    });

    await request(server)
      .get(`/api/barbers/${ana.id}/connect`)
      .set(DEVICE_TOKEN_HEADER, deviceToken)
      .expect(401);
  });

  it('refuses a mutation without the CSRF header', async () => {
    const ana = await makeBarber(ANA_EMAIL, 'Ana');
    const session = await signIn(ANA_EMAIL);

    await request(server)
      .post(`/api/barbers/${ana.id}/connect/onboarding-link`)
      .set('Cookie', session.cookies)
      .expect(403);
  });

  /**
   * The guard must run before Stripe does. The suite's key is a fixture that no real
   * account answers to, so reaching Stripe at all would surface as a 500 — a 403 here is
   * therefore proof the authorization check rejected Ana before any payment code ran.
   */
  it('refuses a cross-barber onboarding link before calling Stripe', async () => {
    await makeBarber(ANA_EMAIL, 'Ana');
    const ben = await makeBarber(BEN_EMAIL, 'Ben');
    const session = await signIn(ANA_EMAIL);

    await request(server)
      .post(`/api/barbers/${ben.id}/connect/onboarding-link`)
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .expect(403);
  });
});
