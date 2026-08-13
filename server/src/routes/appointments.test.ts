/**
 * Whose appointment is it.
 *
 * `GET /appointments` has always scoped a barber to their own book — it overwrites any
 * `barberId` they send with their own. The two routes beside it that *change* an
 * appointment carried `requireUser` and nothing else, which proves somebody is signed in
 * and says nothing about whose chair they are reaching into. So one barber could cancel
 * another barber's client, or mark them a no-show, given only the id.
 *
 * CLAUDE.md is explicit that a barber may only read and write their own appointments.
 * Every case here asserts both halves of that: the owner is allowed AND the stranger is
 * refused, because a guard that also stops the owner would be a worse bug than the one
 * it fixes.
 *
 * Fixtures namespaced to `@appts.test`, cleaned up through the relations.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_HEADER } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';
import { createAppointment, updateAppointmentStatus } from '../services/booking.js';
import { hashPassword } from '../services/passwords.js';

const app = createApp();

// One listening server for the file — see the note in devices.test.ts.
const server = app.listen(0);
afterAll(() => {
  server.close();
});

const PREFIX = 'APPTTEST ';
const PASSWORD = 'FrancisCutz!2026';
const ADMIN_EMAIL = 'admin@appts.test';
const OWNER_EMAIL = 'owner@appts.test';
const OTHER_EMAIL = 'other@appts.test';
const EMAILS = [ADMIN_EMAIL, OWNER_EMAIL, OTHER_EMAIL];

const CLIENT_PHONE = '+14155550811';
const TIMEZONE = 'America/New_York';
/** 2026-08-11 is a Tuesday; 10:00 local is 14:00Z in August. */
const SLOT = new Date('2026-08-11T14:00:00.000Z');
const NOW = new Date('2026-08-01T12:00:00.000Z');

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

const PASSWORD_HASH = await hashPassword(PASSWORD);

let ownerBarberId = '';
let otherBarberId = '';
let cutId = '';

async function cleanup() {
  const mine = { barber: { user: { email: { in: EMAILS } } } };
  await prisma.appointmentService.deleteMany({ where: { appointment: mine } });
  await prisma.appointment.deleteMany({ where: mine });
  await prisma.barberDayLock.deleteMany({ where: mine });
  await prisma.barberSchedule.deleteMany({ where: mine });
  await prisma.barberService.deleteMany({ where: { service: { name: { startsWith: PREFIX } } } });
  await prisma.barber.deleteMany({ where: { user: { email: { in: EMAILS } } } });
  await prisma.session.deleteMany({ where: { user: { email: { in: EMAILS } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.service.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.client.deleteMany({ where: { phoneE164: CLIENT_PHONE } });
}

async function makeBarber(email: string, name: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: PASSWORD_HASH,
      firstName: name,
      lastName: 'Appts',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  const barber = await prisma.barber.create({
    data: { userId: user.id, displayName: `Appts ${name}`, slug: `appts-${user.id}` },
  });

  // Tuesday, 10:00–18:00, so both slots below are inside a working day.
  await prisma.barberSchedule.create({
    data: { barberId: barber.id, dayOfWeek: 2, startMinute: 600, endMinute: 1080 },
  });
  await prisma.barberService.create({ data: { barberId: barber.id, serviceId: cutId } });

  return barber.id;
}

async function reseed() {
  await cleanup();

  await prisma.shopSettings.upsert({
    where: { id: 1 },
    update: { timezone: TIMEZONE, bufferMinutes: 0, bookingHorizonDays: 365 },
    create: { id: 1, name: 'Francis Cutz', timezone: TIMEZONE, bookingHorizonDays: 365 },
  });

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: PASSWORD_HASH,
      firstName: 'Appts',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });

  const cut = await prisma.service.create({
    data: { name: `${PREFIX}Haircut`, priceCents: 4500, durationMinutes: 45 },
  });
  cutId = cut.id;

  ownerBarberId = await makeBarber(OWNER_EMAIL, 'Owner');
  otherBarberId = await makeBarber(OTHER_EMAIL, 'Other');
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

/** One appointment in the owner's book, booked past the notice rules as staff would. */
async function bookForOwner(startAt: Date = SLOT) {
  const appointment = await createAppointment({
    barberId: ownerBarberId,
    serviceIds: [cutId],
    startAt,
    client: { phone: CLIENT_PHONE, firstName: 'Appts' },
    source: 'STAFF' as const,
    enforceMinimumNotice: false,
    enforceOnlineRules: false,
    now: NOW,
  });

  return appointment.id;
}

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('appointment writes are self-or-admin', () => {
  beforeEach(reseed);

  // --- Cancel ----------------------------------------------------------------

  it('lets a barber cancel their own appointment', async () => {
    const id = await bookForOwner();
    const session = await signIn(OWNER_EMAIL);

    const response = await request(server)
      .post(`/api/appointments/${id}/cancel`)
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .send({})
      .expect(200);

    expect(response.body.appointment.status).toBe('CANCELLED');
  });

  /** The one this file exists for. */
  it("refuses a barber cancelling another barber's appointment", async () => {
    const id = await bookForOwner();
    const session = await signIn(OTHER_EMAIL);

    await request(server)
      .post(`/api/appointments/${id}/cancel`)
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .send({})
      .expect(403);

    // Refused, and it did not happen anyway.
    const after = await prisma.appointment.findUnique({ where: { id }, select: { status: true } });
    expect(after?.status).toBe('BOOKED');
  });

  it('lets an admin cancel anyone', async () => {
    const id = await bookForOwner();
    const session = await signIn(ADMIN_EMAIL);

    await request(server)
      .post(`/api/appointments/${id}/cancel`)
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .send({ reason: 'Shop closed early.' })
      .expect(200);
  });

  // --- Status ----------------------------------------------------------------

  it('lets a barber move their own appointment along', async () => {
    const id = await bookForOwner();
    const session = await signIn(OWNER_EMAIL);

    const response = await request(server)
      .patch(`/api/appointments/${id}/status`)
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    expect(response.body.appointment.status).toBe('IN_PROGRESS');
  });

  it("refuses a barber restatusing another barber's appointment", async () => {
    const id = await bookForOwner();
    const session = await signIn(OTHER_EMAIL);

    await request(server)
      .patch(`/api/appointments/${id}/status`)
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .send({ status: 'NO_SHOW' })
      .expect(403);

    const after = await prisma.appointment.findUnique({ where: { id }, select: { status: true } });
    expect(after?.status).toBe('BOOKED');
  });

  it('lets an admin move anyone along', async () => {
    const id = await bookForOwner();
    const session = await signIn(ADMIN_EMAIL);

    await request(server)
      .patch(`/api/appointments/${id}/status`)
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .send({ status: 'COMPLETED' })
      .expect(200);
  });

  /** An id that does not exist must not be distinguishable by a longer route. */
  it('404s on an appointment that does not exist', async () => {
    const session = await signIn(ADMIN_EMAIL);

    await request(server)
      .patch('/api/appointments/cmnotanappointmentid00/status')
      .set('Cookie', session.cookies)
      .set(CSRF_HEADER, session.csrfToken)
      .send({ status: 'COMPLETED' })
      .expect(404);
  });
});

// --- The read half, which already worked --------------------------------------

describe.skipIf(!reachable)('the appointment DTO carries when the cut actually began', () => {
  beforeEach(reseed);

  /**
   * The field `/today` draws its progress bar and its finish time from.
   *
   * Left off the DTO, that screen falls back to `startAt` — the timetable — so a client
   * seated three hours early leaves the bar at zero and "done" reading two o'clock while
   * the barber is mid-cut. It is not enough for the column to exist; it has to reach the
   * screen.
   */
  it('is null until somebody sits down, then carries the real instant', async () => {
    const appointmentId = await bookForOwner();
    const session = await signIn(OWNER_EMAIL);

    const list = async () =>
      (
        await request(server)
          .get('/api/appointments')
          .query({ from: '2026-08-11T00:00:00.000Z', to: '2026-08-12T00:00:00.000Z' })
          .set('Cookie', session.cookies)
          .expect(200)
      ).body.appointments[0];

    expect(await list()).toMatchObject({ startedAt: null });

    const sat = new Date('2026-08-11T15:20:00.000Z');
    await updateAppointmentStatus(appointmentId, 'IN_PROGRESS', sat);

    const started = await list();
    expect(started.startedAt).toBe(sat.toISOString());
    // And it is genuinely a different fact from the slot they were booked into.
    expect(started.startedAt).not.toBe(started.startAt);
  });
});

describe.skipIf(!reachable)('GET /appointments scopes a barber to their own book', () => {
  beforeEach(reseed);

  /**
   * Pinned rather than assumed. The route silently overwrites any `barberId` a
   * non-admin sends, and that behaviour is load-bearing for `/my-day`, which calls it
   * with no barberId at all and trusts the server to know who is asking.
   */
  it("ignores a barberId a barber tries to pass for somebody else", async () => {
    await bookForOwner();
    const session = await signIn(OTHER_EMAIL);

    const response = await request(server)
      .get('/api/appointments')
      .query({
        from: '2026-08-11T00:00:00.000Z',
        to: '2026-08-12T00:00:00.000Z',
        barberId: ownerBarberId,
      })
      .set('Cookie', session.cookies)
      .expect(200);

    // Asked for the owner's book, given their own — which is empty.
    expect(response.body.appointments).toEqual([]);
  });

  it('returns the barber their own appointments with no barberId at all', async () => {
    await bookForOwner();
    const session = await signIn(OWNER_EMAIL);

    const response = await request(server)
      .get('/api/appointments')
      .query({ from: '2026-08-11T00:00:00.000Z', to: '2026-08-12T00:00:00.000Z' })
      .set('Cookie', session.cookies)
      .expect(200);

    expect(response.body.appointments).toHaveLength(1);
    expect(response.body.appointments[0].barberId).toBe(ownerBarberId);
  });

  it('lets an admin ask for one barber', async () => {
    await bookForOwner();
    const session = await signIn(ADMIN_EMAIL);

    const mine = await request(server)
      .get('/api/appointments')
      .query({
        from: '2026-08-11T00:00:00.000Z',
        to: '2026-08-12T00:00:00.000Z',
        barberId: otherBarberId,
      })
      .set('Cookie', session.cookies)
      .expect(200);

    expect(mine.body.appointments).toEqual([]);

    const theirs = await request(server)
      .get('/api/appointments')
      .query({
        from: '2026-08-11T00:00:00.000Z',
        to: '2026-08-12T00:00:00.000Z',
        barberId: ownerBarberId,
      })
      .set('Cookie', session.cookies)
      .expect(200);

    expect(theirs.body.appointments).toHaveLength(1);
  });
});
