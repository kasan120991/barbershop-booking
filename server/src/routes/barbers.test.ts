/**
 * Barber onboarding, schedules and time off through the real middleware stack.
 *
 * Fixtures namespaced to `@schedule.test` with scoped cleanup, per the standing rule.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_HEADER } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../services/passwords.js';

const app = createApp();

/**
 * One listening server for the whole file.
 *
 * `request(app)` starts an ephemeral server and closes it again for EVERY request.
 * That churn is what produced the intermittent "socket hang up" and "Parse Error:
 * Expected HTTP/" failures — a client socket outliving the server it was talking to.
 * They landed in whichever file happened to be running, which is why they read as
 * database contention for two phases. Binding once removes the whole class.
 */
const server = app.listen(0);
afterAll(() => {
  server.close();
});

const PASSWORD = 'FrancisCutz!2026';
const ADMIN_EMAIL = 'admin@schedule.test';
const BARBER_EMAIL = 'barber@schedule.test';
const OTHER_EMAIL = 'other@schedule.test';

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

async function cleanup() {
  const where = { user: { email: { contains: '@schedule.test' } } };
  await prisma.scheduleException.deleteMany({ where: { barber: where } });
  await prisma.barberSchedule.deleteMany({ where: { barber: where } });
  await prisma.barberService.deleteMany({ where: { barber: where } });
  await prisma.barber.deleteMany({ where });
  await prisma.session.deleteMany({ where: { user: { email: { contains: '@schedule.test' } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { contains: '@schedule.test' } } } });
  await prisma.user.deleteMany({ where: { email: { contains: '@schedule.test' } } });
}

async function makeBarber(email: string, displayName: string) {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      firstName: displayName,
      lastName: 'Test',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });
  return prisma.barber.create({
    data: { userId: user.id, displayName, slug: `${displayName.toLowerCase()}-${user.id}` },
  });
}

async function reseed() {
  await cleanup();

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Sched',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });

  await makeBarber(BARBER_EMAIL, 'Schedbarber');
  await makeBarber(OTHER_EMAIL, 'Otherbarber');

  await prisma.shopSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, name: 'Francis Cutz', timezone: 'America/New_York' },
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

async function barberIdFor(email: string) {
  const barber = await prisma.barber.findFirst({ where: { user: { email } } });
  return barber!.id;
}

/** 10:00–13:00 and 13:30–18:00 — the shape every real barber here works. */
const SPLIT_WEEK = [
  { dayOfWeek: 2, startMinute: 600, endMinute: 780 },
  { dayOfWeek: 2, startMinute: 810, endMinute: 1080 },
];

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('barber onboarding', () => {
  beforeEach(reseed);

  it('creates the user, roles and profile together, with a working temporary password', async () => {
    const admin = await signIn(ADMIN_EMAIL);

    const response = await request(server)
      .post('/api/barbers')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        firstName: 'Marcus',
        lastName: 'Reyes',
        email: 'marcus@schedule.test',
        displayName: 'Marcus',
      })
      .expect(201);

    expect(response.body.barber.temporaryPassword).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
    expect(response.body.barber.roles).toEqual(['BARBER']);

    const user = await prisma.user.findUnique({
      where: { email: 'marcus@schedule.test' },
      include: { roles: true, barber: true },
    });

    // The three rows that must exist together.
    expect(user).not.toBeNull();
    expect(user?.barber).not.toBeNull();
    expect(user?.roles.map((r) => r.role)).toEqual(['BARBER']);
    // Pinned to the change-password screen until they replace it.
    expect(user?.mustChangePassword).toBe(true);

    // And the password actually works.
    await request(server)
      .post('/api/auth/login')
      .send({ email: 'marcus@schedule.test', password: response.body.barber.temporaryPassword })
      .expect(200);
  });

  it('can also grant admin, for an owner who cuts hair', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const response = await request(server)
      .post('/api/barbers')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        firstName: 'Owner',
        lastName: 'Two',
        email: 'owner2@schedule.test',
        alsoAdmin: true,
      })
      .expect(201);

    expect(response.body.barber.roles.sort()).toEqual(['ADMIN', 'BARBER']);
  });

  it('refuses a duplicate email with a 409, not a constraint error', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const response = await request(server)
      .post('/api/barbers')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ firstName: 'Dup', lastName: 'Licate', email: BARBER_EMAIL })
      .expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.message).toMatch(/already has an account/i);
  });

  it('never puts the temporary password in the audit log', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const response = await request(server)
      .post('/api/barbers')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ firstName: 'Audit', lastName: 'Check', email: 'audit@schedule.test' })
      .expect(201);

    const entry = await prisma.auditLog.findFirst({
      where: { entityId: response.body.barber.barberId, action: 'barber.created' },
    });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry?.after)).not.toContain(response.body.barber.temporaryPassword);
  });
});

describe.skipIf(!reachable)('weekly schedule', () => {
  beforeEach(reseed);

  it('round-trips a split shift unchanged', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const barberId = await barberIdFor(BARBER_EMAIL);

    const response = await request(server)
      .put(`/api/barbers/${barberId}/schedule`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ shifts: SPLIT_WEEK })
      .expect(200);

    expect(response.body.shifts).toHaveLength(2);
    expect(response.body.shifts.map((s: { startMinute: number }) => s.startMinute)).toEqual([600, 810]);
  });

  it('replaces the week rather than appending to it', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const barberId = await barberIdFor(BARBER_EMAIL);
    const headers = { Cookie: admin.cookies, [CSRF_HEADER]: admin.csrfToken };

    await request(server).put(`/api/barbers/${barberId}/schedule`).set(headers).send({ shifts: SPLIT_WEEK }).expect(200);

    const second = await request(server)
      .put(`/api/barbers/${barberId}/schedule`)
      .set(headers)
      .send({ shifts: [{ dayOfWeek: 5, startMinute: 540, endMinute: 1020 }] })
      .expect(200);

    expect(second.body.shifts).toHaveLength(1);
    expect(second.body.shifts[0].dayOfWeek).toBe(5);
  });

  /** The check the database cannot make: different starts, overlapping ranges. */
  it('rejects an overlap and leaves the existing week untouched', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const barberId = await barberIdFor(BARBER_EMAIL);
    const headers = { Cookie: admin.cookies, [CSRF_HEADER]: admin.csrfToken };

    await request(server).put(`/api/barbers/${barberId}/schedule`).set(headers).send({ shifts: SPLIT_WEEK }).expect(200);

    const response = await request(server)
      .put(`/api/barbers/${barberId}/schedule`)
      .set(headers)
      .send({
        shifts: [
          { dayOfWeek: 2, startMinute: 600, endMinute: 780 },
          { dayOfWeek: 2, startMinute: 660, endMinute: 840 },
        ],
      })
      .expect(400);

    expect(response.body.error.message).toMatch(/overlaps/i);

    // A refused week must not have destroyed the one that was there.
    const kept = await prisma.barberSchedule.findMany({ where: { barberId } });
    expect(kept).toHaveLength(2);
  });

  it('accepts an empty week, meaning not currently working', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const barberId = await barberIdFor(BARBER_EMAIL);

    const response = await request(server)
      .put(`/api/barbers/${barberId}/schedule`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ shifts: [] })
      .expect(200);

    expect(response.body.shifts).toEqual([]);
  });
});

describe.skipIf(!reachable)('time off', () => {
  beforeEach(reseed);

  /** Winter: America/New_York is UTC-5, so an all-day entry starts at 05:00Z. */
  it('converts an all-day winter date to the shop timezone', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const barberId = await barberIdFor(BARBER_EMAIL);

    const response = await request(server)
      .post(`/api/barbers/${barberId}/exceptions`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ kind: 'TIME_OFF', startDate: '2027-01-15', allDay: true, reason: 'Vacation' })
      .expect(201);

    const row = await prisma.scheduleException.findUnique({
      where: { id: response.body.exception.id },
    });

    expect(row?.startAt.toISOString()).toBe('2027-01-15T05:00:00.000Z');
    expect(row?.endAt.toISOString()).toBe('2027-01-16T05:00:00.000Z');
    expect(row?.type).toBe('TIME_OFF');

    // Reads back as the same local date the admin typed.
    expect(response.body.exception.startDate).toBe('2027-01-15');
    expect(response.body.exception.endDate).toBe('2027-01-15');
    expect(response.body.exception.allDay).toBe(true);
  });

  /** Summer: UTC-4, so the same shape starts an hour earlier in UTC. */
  it('converts an all-day summer date with the other offset', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const barberId = await barberIdFor(BARBER_EMAIL);

    const response = await request(server)
      .post(`/api/barbers/${barberId}/exceptions`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ kind: 'TIME_OFF', startDate: '2027-07-04', allDay: true })
      .expect(201);

    const row = await prisma.scheduleException.findUnique({
      where: { id: response.body.exception.id },
    });
    expect(row?.startAt.toISOString()).toBe('2027-07-04T04:00:00.000Z');
  });

  it('stores a partial day as BLOCK and keeps its times', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const barberId = await barberIdFor(BARBER_EMAIL);

    const response = await request(server)
      .post(`/api/barbers/${barberId}/exceptions`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        kind: 'TIME_OFF',
        startDate: '2027-01-20',
        allDay: false,
        startTime: '14:00',
        endTime: '15:30',
        reason: 'Dentist',
      })
      .expect(201);

    const row = await prisma.scheduleException.findUnique({
      where: { id: response.body.exception.id },
    });

    // 14:00 in New York in January is 19:00 UTC.
    expect(row?.type).toBe('BLOCK');
    expect(row?.startAt.toISOString()).toBe('2027-01-20T19:00:00.000Z');
    expect(response.body.exception.allDay).toBe(false);
    expect(response.body.exception.startTime).toBe('14:00');
    expect(response.body.exception.endTime).toBe('15:30');
  });

  it('stores extra hours as EXTRA_HOURS', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const barberId = await barberIdFor(BARBER_EMAIL);

    const response = await request(server)
      .post(`/api/barbers/${barberId}/exceptions`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        kind: 'EXTRA_HOURS',
        startDate: '2027-01-24',
        allDay: false,
        startTime: '09:00',
        endTime: '12:00',
      })
      .expect(201);

    const row = await prisma.scheduleException.findUnique({
      where: { id: response.body.exception.id },
    });
    expect(row?.type).toBe('EXTRA_HOURS');
    expect(response.body.exception.kind).toBe('EXTRA_HOURS');
  });

  it('rejects extra hours with no times, and a partial day with no times', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const barberId = await barberIdFor(BARBER_EMAIL);
    const headers = { Cookie: admin.cookies, [CSRF_HEADER]: admin.csrfToken };

    await request(server)
      .post(`/api/barbers/${barberId}/exceptions`)
      .set(headers)
      .send({ kind: 'EXTRA_HOURS', startDate: '2027-01-24', allDay: true })
      .expect(400);

    await request(server)
      .post(`/api/barbers/${barberId}/exceptions`)
      .set(headers)
      .send({ kind: 'TIME_OFF', startDate: '2027-01-24', allDay: false })
      .expect(400);
  });

  it('deletes an entry', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const barberId = await barberIdFor(BARBER_EMAIL);
    const headers = { Cookie: admin.cookies, [CSRF_HEADER]: admin.csrfToken };

    const created = await request(server)
      .post(`/api/barbers/${barberId}/exceptions`)
      .set(headers)
      .send({ kind: 'TIME_OFF', startDate: '2027-03-01', allDay: true })
      .expect(201);

    await request(server)
      .delete(`/api/schedule-exceptions/${created.body.exception.id}`)
      .set(headers)
      .expect(204);

    expect(
      await prisma.scheduleException.findUnique({ where: { id: created.body.exception.id } }),
    ).toBeNull();
  });
});

describe.skipIf(!reachable)('authorization', () => {
  beforeEach(reseed);

  it('lets a barber read their own schedule', async () => {
    const barber = await signIn(BARBER_EMAIL);
    const ownId = await barberIdFor(BARBER_EMAIL);

    await request(server).get(`/api/barbers/${ownId}/schedule`).set('Cookie', barber.cookies).expect(200);
    await request(server).get(`/api/barbers/${ownId}/exceptions`).set('Cookie', barber.cookies).expect(200);
  });

  it("refuses a barber another barber's schedule", async () => {
    const barber = await signIn(BARBER_EMAIL);
    const otherId = await barberIdFor(OTHER_EMAIL);

    const response = await request(server)
      .get(`/api/barbers/${otherId}/schedule`)
      .set('Cookie', barber.cookies)
      .expect(403);

    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses a barber every write, including to their own schedule', async () => {
    const barber = await signIn(BARBER_EMAIL);
    const ownId = await barberIdFor(BARBER_EMAIL);
    const headers = { Cookie: barber.cookies, [CSRF_HEADER]: barber.csrfToken };

    await request(server).put(`/api/barbers/${ownId}/schedule`).set(headers).send({ shifts: [] }).expect(403);
    await request(server)
      .post(`/api/barbers/${ownId}/exceptions`)
      .set(headers)
      .send({ kind: 'TIME_OFF', startDate: '2027-02-01', allDay: true })
      .expect(403);
    await request(server)
      .post('/api/barbers')
      .set(headers)
      .send({ firstName: 'No', lastName: 'Way', email: 'nope@schedule.test' })
      .expect(403);
  });

  it('401s anonymous access', async () => {
    const ownId = await barberIdFor(BARBER_EMAIL);
    await request(server).get(`/api/barbers/${ownId}/schedule`).expect(401);
  });
});

describe.skipIf(!reachable)('GET /working-hours', () => {
  // 2026-08-18 is a Tuesday — the weekday the fixture schedule below is for.
  const TUESDAY = '2026-08-18';

  beforeEach(async () => {
    await reseed();

    // Tuesday must be open. Matches what the seed already has rather than widening
    // it, so nothing else sees a different Tuesday, and cleanup can leave it alone.
    await prisma.shopHours.upsert({
      where: { dayOfWeek_openMinute: { dayOfWeek: 2, openMinute: 540 } },
      update: { closeMinute: 1020, isClosed: false },
      create: { dayOfWeek: 2, openMinute: 540, closeMinute: 1020, isClosed: false },
    });

    // Schedbarber works the split Tuesday; Otherbarber has no schedule at all.
    const ownId = await barberIdFor(BARBER_EMAIL);
    await prisma.barberSchedule.createMany({
      data: [
        { barberId: ownId, dayOfWeek: 2, startMinute: 600, endMinute: 780 },
        { barberId: ownId, dayOfWeek: 2, startMinute: 810, endMinute: 1080 },
      ],
    });
  });

  it('forces a barber to their own chair, whatever barberId they pass', async () => {
    const barber = await signIn(BARBER_EMAIL);
    const ownId = await barberIdFor(BARBER_EMAIL);
    const otherId = await barberIdFor(OTHER_EMAIL);

    const response = await request(server)
      .get(`/api/working-hours?from=${TUESDAY}&days=1&barberId=${otherId}`)
      .set('Cookie', barber.cookies)
      .expect(200);

    expect(response.body.days).toHaveLength(1);
    expect(response.body.days[0].date).toBe(TUESDAY);
    // The requested barberId was overwritten with their own — nobody else's day came back.
    expect(response.body.days[0].barbers).toHaveLength(1);

    const own = response.body.days[0].barbers[0];
    expect(own.barberId).toBe(ownId);
    expect(own.reason).toBeNull();
    // The split shift arrives as two intervals: 10:00–13:00, then 13:30 until the
    // shop's 17:00 close clips the 18:00 shift end — working ∩ open, not just working.
    expect(own.intervals).toEqual([
      { startAt: '2026-08-18T14:00:00.000Z', endAt: '2026-08-18T17:00:00.000Z' },
      { startAt: '2026-08-18T17:30:00.000Z', endAt: '2026-08-18T21:00:00.000Z' },
    ]);
  });

  it('gives an admin every active barber when none is named', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const ownId = await barberIdFor(BARBER_EMAIL);
    const otherId = await barberIdFor(OTHER_EMAIL);

    const response = await request(server)
      .get(`/api/working-hours?from=${TUESDAY}&days=2`)
      .set('Cookie', admin.cookies)
      .expect(200);

    expect(response.body.days).toHaveLength(2);
    expect(response.body.days[1].date).toBe('2026-08-19');

    // The shared database may hold other files' barbers — find ours, never index.
    const rows = response.body.days[0].barbers as {
      barberId: string;
      intervals: unknown[];
      reason: string | null;
    }[];
    const scheduled = rows.find((row) => row.barberId === ownId);
    const unscheduled = rows.find((row) => row.barberId === otherId);

    expect(scheduled?.intervals).toHaveLength(2);
    expect(scheduled?.reason).toBeNull();
    // No schedule rows at all — the engine's own sentence, not an empty shrug.
    expect(unscheduled?.intervals).toHaveLength(0);
    expect(unscheduled?.reason).toBe('This barber is not working on this day.');
  });

  it('lets an admin narrow to one barber', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    const otherId = await barberIdFor(OTHER_EMAIL);

    const response = await request(server)
      .get(`/api/working-hours?from=${TUESDAY}&days=1&barberId=${otherId}`)
      .set('Cookie', admin.cookies)
      .expect(200);

    expect(response.body.days[0].barbers).toHaveLength(1);
    expect(response.body.days[0].barbers[0].barberId).toBe(otherId);
  });

  it('rejects a malformed date and an out-of-range span', async () => {
    const admin = await signIn(ADMIN_EMAIL);
    await request(server)
      .get('/api/working-hours?from=18-08-2026')
      .set('Cookie', admin.cookies)
      .expect(400);
    await request(server)
      .get(`/api/working-hours?from=${TUESDAY}&days=60`)
      .set('Cookie', admin.cookies)
      .expect(400);
  });

  it('401s anonymous access', async () => {
    await request(server).get(`/api/working-hours?from=${TUESDAY}`).expect(401);
  });
});
