/**
 * Catalog behaviour through the real middleware stack.
 *
 * Fixtures are namespaced to this file (`@catalog.test`, `CATTEST ` labels) and every
 * cleanup is scoped to them — vitest runs test files in parallel against one database,
 * so an unscoped `deleteMany` silently breaks whichever file is running alongside.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_HEADER } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../services/passwords.js';

const app = createApp();

const PASSWORD = 'FrancisCutz!2026';
const ADMIN_EMAIL = 'admin@catalog.test';
const BARBER_EMAIL = 'barber@catalog.test';
const PREFIX = 'CATTEST ';

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

async function cleanup() {
  await prisma.appointmentService.deleteMany({ where: { service: { name: { startsWith: PREFIX } } } });
  await prisma.appointment.deleteMany({ where: { notes: PREFIX } });
  await prisma.barberService.deleteMany({ where: { service: { name: { startsWith: PREFIX } } } });
  await prisma.service.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.client.deleteMany({ where: { phoneE164: '+14155550777' } });
  await prisma.session.deleteMany({ where: { user: { email: { contains: '@catalog.test' } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { contains: '@catalog.test' } } } });
  await prisma.barber.deleteMany({ where: { user: { email: { contains: '@catalog.test' } } } });
  await prisma.user.deleteMany({ where: { email: { contains: '@catalog.test' } } });
}

async function reseed() {
  await cleanup();
  const passwordHash = await hashPassword(PASSWORD);

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash,
      firstName: 'Cat',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });

  const barberUser = await prisma.user.create({
    data: {
      email: BARBER_EMAIL,
      passwordHash,
      firstName: 'Cat',
      lastName: 'Barber',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });
  await prisma.barber.create({
    data: {
      userId: barberUser.id,
      displayName: 'Cat Barber',
      slug: `cat-barber-${barberUser.id}`,
    },
  });

  // Shop settings are a singleton the seed owns; ensure it exists for closure tests.
  await prisma.shopSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, name: 'Francis Cutz', timezone: 'America/New_York' },
  });
}

async function signIn(email: string) {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return {
    cookies: response.headers['set-cookie'] as unknown as string[],
    csrfToken: response.body.csrfToken as string,
  };
}

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    name: `${PREFIX}Haircut`,
    priceCents: 4500,
    durationMinutes: 45,
    sortOrder: 1,
    bookableOnline: true,
    bookableWalkIn: true,
    ...overrides,
  };
}

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('services', () => {
  beforeEach(reseed);

  it('creates a service with money as integer cents', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    const response = await request(app)
      .post('/api/services')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(makeService())
      .expect(201);

    expect(response.body.service.priceCents).toBe(4500);
    expect(Number.isInteger(response.body.service.priceCents)).toBe(true);
  });

  it('rejects a float or negative price', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    for (const priceCents of [45.5, -100]) {
      const response = await request(app)
        .post('/api/services')
        .set('Cookie', admin.cookies)
        .set(CSRF_HEADER, admin.csrfToken)
        .send(makeService({ priceCents }))
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('updates only the fields sent', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const created = await request(app)
      .post('/api/services')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(makeService())
      .expect(201);

    const updated = await request(app)
      .patch(`/api/services/${created.body.service.id}`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ priceCents: 5000 })
      .expect(200);

    expect(updated.body.service.priceCents).toBe(5000);
    // Untouched fields survive a partial update.
    expect(updated.body.service.durationMinutes).toBe(45);
    expect(updated.body.service.name).toBe(`${PREFIX}Haircut`);
  });

  it('hides archived services from the public list but keeps them for staff', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const created = await request(app)
      .post('/api/services')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(makeService({ name: `${PREFIX}Archived` }))
      .expect(201);

    await request(app)
      .patch(`/api/services/${created.body.service.id}`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ isActive: false })
      .expect(200);

    const anonymous = await request(app).get('/api/services').expect(200);
    expect(anonymous.body.services.some((s: { name: string }) => s.name === `${PREFIX}Archived`)).toBe(
      false,
    );

    const staff = await request(app).get('/api/services').set('Cookie', admin.cookies).expect(200);
    expect(staff.body.services.some((s: { name: string }) => s.name === `${PREFIX}Archived`)).toBe(
      true,
    );
  });

  it('assigns barbers to a service, replacing the previous set', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const created = await request(app)
      .post('/api/services')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(makeService())
      .expect(201);

    const barber = await prisma.barber.findFirst({ where: { user: { email: BARBER_EMAIL } } });

    await request(app)
      .put(`/api/services/${created.body.service.id}/barbers`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ barberIds: [barber!.id] })
      .expect(204);

    const listed = await request(app).get('/api/services').set('Cookie', admin.cookies).expect(200);
    const service = listed.body.services.find(
      (s: { id: string }) => s.id === created.body.service.id,
    );
    expect(service.barberIds).toEqual([barber!.id]);

    // Sending an empty set clears it rather than being ignored.
    await request(app)
      .put(`/api/services/${created.body.service.id}/barbers`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ barberIds: [] })
      .expect(204);

    const cleared = await request(app).get('/api/services').set('Cookie', admin.cookies).expect(200);
    expect(
      cleared.body.services.find((s: { id: string }) => s.id === created.body.service.id).barberIds,
    ).toEqual([]);
  });

  it('writes an audit row for a price change', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const created = await request(app)
      .post('/api/services')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(makeService())
      .expect(201);

    await request(app)
      .patch(`/api/services/${created.body.service.id}`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ priceCents: 6000 })
      .expect(200);

    const entries = await prisma.auditLog.findMany({
      where: { entityId: created.body.service.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(entries.map((e) => e.action)).toContain('service.updated');
    const update = entries.find((e) => e.action === 'service.updated');
    expect((update?.before as { priceCents: number }).priceCents).toBe(4500);
    expect((update?.after as { priceCents: number }).priceCents).toBe(6000);
  });
});

describe.skipIf(!reachable)('deleting a service', () => {
  beforeEach(reseed);

  it('deletes one that has never been booked', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const created = await request(app)
      .post('/api/services')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(makeService({ name: `${PREFIX}Typo` }))
      .expect(201);

    await request(app)
      .delete(`/api/services/${created.body.service.id}`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .expect(204);

    expect(await prisma.service.findUnique({ where: { id: created.body.service.id } })).toBeNull();
  });

  /**
   * The rule that protects appointment history. A booked service must survive, or
   * past appointments lose the row their foreign key points at.
   */
  it('refuses to delete one that has been booked, and says to archive instead', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const created = await request(app)
      .post('/api/services')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(makeService({ name: `${PREFIX}Booked` }))
      .expect(201);

    const barber = await prisma.barber.findFirst({ where: { user: { email: BARBER_EMAIL } } });
    const client = await prisma.client.create({
      data: { phoneE164: '+14155550777', firstName: 'Booked' },
    });
    const appointment = await prisma.appointment.create({
      data: {
        clientId: client.id,
        barberId: barber!.id,
        startAt: new Date('2026-08-01T14:00:00.000Z'),
        endAt: new Date('2026-08-01T14:45:00.000Z'),
        durationMinutes: 45,
        priceCentsTotal: 4500,
        notes: PREFIX,
      },
    });
    await prisma.appointmentService.create({
      data: {
        appointmentId: appointment.id,
        serviceId: created.body.service.id,
        priceCents: 4500,
        durationMinutes: 45,
        nameSnapshot: `${PREFIX}Booked`,
      },
    });

    const response = await request(app)
      .delete(`/api/services/${created.body.service.id}`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.message).toMatch(/archive/i);

    // Still there, and the appointment still resolves.
    expect(
      await prisma.service.findUnique({ where: { id: created.body.service.id } }),
    ).not.toBeNull();
  });

  it('reports usage so the UI can hide Delete rather than offer a failure', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const created = await request(app)
      .post('/api/services')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(makeService({ name: `${PREFIX}Unused` }))
      .expect(201);

    const response = await request(app)
      .get(`/api/services/${created.body.service.id}/usage`)
      .set('Cookie', admin.cookies)
      .expect(200);

    expect(response.body.usageCount).toBe(0);
  });
});

describe.skipIf(!reachable)('shop hours and closures', () => {
  beforeEach(reseed);

  it('replaces the whole week and round-trips minutes from midnight', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      openMinute: 540,
      closeMinute: 1020,
      isClosed: dayOfWeek === 0,
    }));

    const response = await request(app)
      .put('/api/shop-hours')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ hours })
      .expect(200);

    expect(response.body.settings.hours).toHaveLength(7);
    const saturday = response.body.settings.hours.find((h: { dayOfWeek: number }) => h.dayOfWeek === 6);
    expect(saturday.openMinute).toBe(540);
    expect(saturday.closeMinute).toBe(1020);
    expect(
      response.body.settings.hours.find((h: { dayOfWeek: number }) => h.dayOfWeek === 0).isClosed,
    ).toBe(true);
  });

  it('rejects a week that is missing a day', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const hours = Array.from({ length: 6 }, (_, dayOfWeek) => ({
      dayOfWeek,
      openMinute: 540,
      closeMinute: 1020,
      isClosed: false,
    }));

    await request(app)
      .put('/api/shop-hours')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ hours })
      .expect(400);
  });

  it('rejects a closing time before opening', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      openMinute: 1020,
      closeMinute: 540,
      isClosed: false,
    }));

    await request(app)
      .put('/api/shop-hours')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ hours })
      .expect(400);
  });

  /**
   * A WINTER date on purpose. America/New_York is UTC-5 in January and UTC-4 in July,
   * so a naive `new Date('2026-01-15')` — which parses as UTC midnight — shows up here
   * as a whole-hour offset rather than passing by luck.
   */
  it('converts a local closure date to the shop timezone, not UTC', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    const created = await request(app)
      .post('/api/shop-closures')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ startDate: '2026-01-15', endDate: '2026-01-15', reason: 'CATTEST winter' })
      .expect(201);

    const row = await prisma.shopClosure.findUnique({ where: { id: created.body.closure.id } });

    // Midnight in New York on 15 Jan is 05:00 UTC, and the exclusive end is the 16th.
    expect(row?.startAt.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(row?.endAt.toISOString()).toBe('2026-01-16T05:00:00.000Z');

    // And it reads back as the same local date the admin typed.
    expect(created.body.closure.startDate).toBe('2026-01-15');
    expect(created.body.closure.endDate).toBe('2026-01-15');

    await prisma.shopClosure.delete({ where: { id: created.body.closure.id } });
  });

  it('converts a summer date with the other offset', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    const created = await request(app)
      .post('/api/shop-closures')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ startDate: '2026-07-04', endDate: '2026-07-04', reason: 'CATTEST summer' })
      .expect(201);

    const row = await prisma.shopClosure.findUnique({ where: { id: created.body.closure.id } });
    // UTC-4 in July, so 04:00 rather than 05:00 — the difference the library exists for.
    expect(row?.startAt.toISOString()).toBe('2026-07-04T04:00:00.000Z');

    await prisma.shopClosure.delete({ where: { id: created.body.closure.id } });
  });

  it('rejects an end date before the start', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    await request(app)
      .post('/api/shop-closures')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ startDate: '2026-12-25', endDate: '2026-12-24' })
      .expect(400);
  });

  it('rejects an unknown timezone', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    await request(app)
      .patch('/api/shop-settings')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ timezone: 'Mars/Olympus_Mons' })
      .expect(400);
  });
});

describe.skipIf(!reachable)('authorization', () => {
  beforeEach(reseed);

  it('lets anyone read the menu and the roster', async () => {
    await request(app).get('/api/services').expect(200);
    await request(app).get('/api/barbers').expect(200);
    await request(app).get('/api/shop-settings').expect(200);
  });

  /**
   * These assert on THIS file's own barber, found by name — never on `barbers[0]`.
   * The roster is global, and other test files create and delete barbers in parallel,
   * so an index would be testing whatever happened to be first at that instant.
   */
  it('never exposes Stripe fields on the public roster', async () => {
    const response = await request(app).get('/api/barbers').expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('stripe');
    expect(serialized).not.toContain('chargesEnabled');

    const mine = response.body.barbers.find(
      (barber: { displayName: string }) => barber.displayName === 'Cat Barber',
    );
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty('email');
    expect(mine).not.toHaveProperty('stripeAccountId');
  });

  it('does expose account state to signed-in staff', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const response = await request(app).get('/api/barbers').set('Cookie', admin.cookies).expect(200);

    const mine = response.body.barbers.find(
      (barber: { displayName: string }) => barber.displayName === 'Cat Barber',
    );
    expect(mine).toBeDefined();
    expect(mine).toHaveProperty('stripeConnected');
    expect(mine.email).toBe(BARBER_EMAIL);
    // Still a boolean, never the account id itself.
    expect(typeof mine.stripeConnected).toBe('boolean');
  });

  it('403s a barber on every write', async () => {
    const barber = await signIn(BARBER_EMAIL);
    const headers = { Cookie: barber.cookies, [CSRF_HEADER]: barber.csrfToken };

    await request(app).post('/api/services').set(headers).send(makeService()).expect(403);
    await request(app).patch('/api/shop-settings').set(headers).send({ name: 'Nope' }).expect(403);
    await request(app)
      .post('/api/shop-closures')
      .set(headers)
      .send({ startDate: '2026-12-25', endDate: '2026-12-25' })
      .expect(403);
  });

  it('401s an anonymous write', async () => {
    await request(app).post('/api/services').send(makeService()).expect(401);
  });
});
