/**
 * Who may see and change rent.
 *
 * Rent is money owed *to the shop*, so the asymmetry matters more here than anywhere else:
 * a barber may read their own ledger in full and change none of it. Being able to check what
 * you are charged is not the same as being able to decide it.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_HEADER } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../services/passwords.js';

const app = createApp();

// One listening server for the file — see the note in devices.test.ts.
const server = app.listen(0);
afterAll(() => {
  server.close();
});

const DOMAIN = '@rentroutes.test';
const ADMIN_EMAIL = `admin${DOMAIN}`;
const ANA_EMAIL = `ana${DOMAIN}`;
const BEN_EMAIL = `ben${DOMAIN}`;
const PASSWORD = 'FrancisCutz!2026';

const passwordHash = await hashPassword(PASSWORD);

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

let anaId: string;
let benId: string;

async function cleanup() {
  const scope = { barber: { user: { email: { contains: DOMAIN } } } };
  await prisma.rentPayment.deleteMany({ where: { rentCharge: scope } });
  await prisma.rentCharge.deleteMany({ where: scope });
  await prisma.rentPlan.deleteMany({ where: scope });
  await prisma.barber.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.session.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { contains: DOMAIN } } } });
  await prisma.user.deleteMany({ where: { email: { contains: DOMAIN } } });
}

async function makeBarber(email: string, name: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: name,
      lastName: 'Rent',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  const barber = await prisma.barber.create({
    data: { userId: user.id, displayName: name, slug: `${name.toLowerCase()}-${user.id}` },
  });

  return barber.id;
}

async function seed() {
  await cleanup();

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash,
      firstName: 'Rent',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });

  anaId = await makeBarber(ANA_EMAIL, 'Ana');
  benId = await makeBarber(BEN_EMAIL, 'Ben');
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

const PLAN = {
  amountCents: 25_000,
  cadence: 'WEEKLY',
  anchorDay: 1,
  startDate: '2026-07-06',
};

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('rent access', () => {
  beforeEach(seed);

  it('lets a barber read their own ledger', async () => {
    const session = await signIn(ANA_EMAIL);

    const response = await request(server)
      .get(`/api/barbers/${anaId}/rent`)
      .set('Cookie', session.cookies)
      .expect(200);

    expect(response.body).toMatchObject({ barberId: anaId, plan: null, charges: [] });
    expect(response.body.summary.outstandingCents).toBe(0);
  });

  /** The one that matters: Ana must never learn what Ben owes. */
  it("refuses one barber another barber's ledger", async () => {
    const session = await signIn(ANA_EMAIL);

    await request(server)
      .get(`/api/barbers/${benId}/rent`)
      .set('Cookie', session.cookies)
      .expect(403);
  });

  /** Reading your own rent is fine; setting what it costs is the shop's decision. */
  it('refuses a barber setting their own rent', async () => {
    const session = await signIn(ANA_EMAIL);

    await request(server)
      .put(`/api/barbers/${anaId}/rent-plan`)
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .send(PLAN)
      .expect(403);
  });

  it('refuses a barber recording their own payment', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const created = await request(server)
      .post(`/api/barbers/${anaId}/rent-charges`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        amountCents: 25_000,
        periodStart: '2026-08-03',
        periodEnd: '2026-08-09',
        dueDate: '2026-08-03',
      })
      .expect(201);

    const session = await signIn(ANA_EMAIL);

    await request(server)
      .post(`/api/rent-charges/${created.body.id}/payments`)
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .send({ amountCents: 25_000, method: 'CASH' })
      .expect(403);
  });

  it('lets an admin set a plan and read any chair', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    await request(server)
      .put(`/api/barbers/${anaId}/rent-plan`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(PLAN)
      .expect(201);

    const response = await request(server)
      .get(`/api/barbers/${benId}/rent`)
      .set('Cookie', admin.cookies)
      .expect(200);

    expect(response.body.barberId).toBe(benId);
  });

  /**
   * Saving a plan must not raise charges.
   *
   * It did: the handler captured its audit "before" with `getRentForBarber`, which generates
   * as a side effect, so replacing a plan first raised a month of charges under the plan
   * being replaced. Found against the live database, not by any test that existed.
   */
  it('raises no charges as a side effect of REPLACING a plan', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    const put = (body: object) =>
      request(server)
        .put(`/api/barbers/${anaId}/rent-plan`)
        .set('Cookie', admin.cookies)
        .set(CSRF_HEADER, admin.csrfToken)
        .send(body)
        .expect(201);

    /**
     * Two saves, and the second is the one under test.
     *
     * The bug only bites when a plan already exists: the handler's audit snapshot read the
     * *outgoing* plan through a function that generates, so replacing a backdated plan
     * raised months of charges on the way past. A single save has nothing to generate from,
     * which is how the first version of this test passed while the bug was still in.
     */
    await put({ ...PLAN, startDate: '2026-01-05' });
    expect(await prisma.rentCharge.count({ where: { barberId: anaId } })).toBe(0);

    await put({ ...PLAN, startDate: '2026-08-03' });
    expect(await prisma.rentCharge.count({ where: { barberId: anaId } })).toBe(0);
  });

  /** And reading is still what brings the ledger up to date. */
  it('raises the charges on the next read', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    await request(server)
      .put(`/api/barbers/${anaId}/rent-plan`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(PLAN)
      .expect(201);

    const response = await request(server)
      .get(`/api/barbers/${anaId}/rent`)
      .set('Cookie', admin.cookies)
      .expect(200);

    expect(response.body.charges.length).toBeGreaterThan(0);
    expect(response.body.summary.outstandingCents).toBeGreaterThan(0);
  });
  /**
   * The counter's endpoint: a sum against the chair, not against a week.
   *
   * Admin-only for the same reason every other write is — a barber saying they paid is not
   * evidence the shop received it.
   */
  it('refuses a barber allocating a payment to their own chair', async () => {
    const session = await signIn(ANA_EMAIL);

    await request(server)
      .post(`/api/barbers/${anaId}/rent-payments`)
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .send({ amountCents: 25_000, method: 'CASH' })
      .expect(403);
  });

  it('spreads an admin payment across the weeks it settles', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    // A plan starting four Mondays back, brought up to date by the read below it.
    await request(server)
      .put(`/api/barbers/${anaId}/rent-plan`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(PLAN)
      .expect(201);

    const before = await request(server)
      .get(`/api/barbers/${anaId}/rent`)
      .set('Cookie', admin.cookies)
      .expect(200);

    const outstanding = before.body.summary.outstandingCents as number;
    // Enough to clear two weeks and start a third, whatever today happens to be.
    const paid = Math.min(outstanding, 60_000);

    const response = await request(server)
      .post(`/api/barbers/${anaId}/rent-payments`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ amountCents: paid, method: 'CASH' })
      .expect(201);

    const allocated = response.body.allocated as { amountCents: number }[];
    expect(allocated.length).toBeGreaterThan(1);
    expect(allocated.reduce((total, slice) => total + slice.amountCents, 0)).toBe(paid);

    const after = await request(server)
      .get(`/api/barbers/${anaId}/rent`)
      .set('Cookie', admin.cookies)
      .expect(200);

    expect(after.body.summary.outstandingCents).toBe(outstanding - paid);
  });

  /** Overpaying is refused with the figure that would have worked, not silently absorbed. */
  it('refuses more than the chair owes', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    await request(server)
      .post(`/api/barbers/${anaId}/rent-charges`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        amountCents: 25_000,
        periodStart: '2026-08-03',
        periodEnd: '2026-08-09',
        dueDate: '2026-08-03',
      })
      .expect(201);

    const response = await request(server)
      .post(`/api/barbers/${anaId}/rent-payments`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ amountCents: 30_000, method: 'CASH' })
      .expect(409);

    expect(response.body.error.message).toContain('250.00');
  });
});
