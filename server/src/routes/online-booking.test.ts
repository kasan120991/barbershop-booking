/**
 * The shop's online switches, and the read half of the cancel link.
 *
 * `onlineBookingEnabled`, `Service.bookableOnline` and `Barber.acceptsOnline` sat in
 * the schema and the admin UI for eight phases with nothing reading them. That was
 * harmless only because there was no public client; the booking site is that client.
 *
 * Every case here is really the same assertion twice — the public is refused AND staff
 * are not. A switch that says *online* which also stops the person at the desk would be
 * a worse bug than the one it fixes, and it is the half a careless implementation gets
 * wrong.
 *
 * Fixtures namespaced to `@online.test`, cleaned up through the relations.
 */

import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { createAppointment } from '../services/booking.js';
import { hashPassword } from '../services/passwords.js';

const app = createApp();

/**
 * One listening server for the whole file.
 *
 * `request(app)` starts an ephemeral server and closes it again for EVERY request.
 * That churn is what produced the intermittent "socket hang up" and "Parse Error:
 * Expected HTTP/" failures — a client socket outliving the server it was talking to.
 */
const server = app.listen(0);
afterAll(() => {
  server.close();
});

const PREFIX = 'ONTEST ';
const PASSWORD = 'FrancisCutz!2026';
const ADMIN_EMAIL = 'admin@online.test';
const BARBER_EMAIL = 'barber@online.test';
const EMAILS = [ADMIN_EMAIL, BARBER_EMAIL];

const CLIENT_PHONE = '+14155550701';
const PHONES = [CLIENT_PHONE];

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

const PASSWORD_HASH = await hashPassword(PASSWORD);

const TIMEZONE = 'America/New_York';
/**
 * A Tuesday at 10:00 in the shop's zone, always comfortably ahead of the real clock.
 *
 * These were two hardcoded instants, and that made the file a time bomb: the public
 * booking path is the one thing here with no injectable clock — it checks `startAt`
 * against the real `now` — so on the very day the constant named, four tests began
 * failing at ten in the morning with nothing wrong with the code. Derived from `now`
 * instead, and two weeks out so the minimum-notice window is never the reason.
 *
 * Tuesday because that is the weekday `reseed` gives the barber a schedule on; luxon
 * counts weekdays from Monday, so Tuesday is 2. Well inside `bookingHorizonDays: 365`.
 */
const SLOT = DateTime.now()
  .setZone(TIMEZONE)
  .plus({ weeks: 2 })
  .set({ weekday: 2, hour: 10, minute: 0, second: 0, millisecond: 0 })
  .toJSDate();

/** The injected clock for the staff path. Only has to sit before `SLOT`. */
const NOW = DateTime.now().setZone(TIMEZONE).startOf('day').toJSDate();

let barberId = '';
let cutId = '';

async function cleanup() {
  await prisma.appointmentService.deleteMany({
    where: { appointment: { barber: { user: { email: { in: EMAILS } } } } },
  });
  await prisma.appointment.deleteMany({ where: { barber: { user: { email: { in: EMAILS } } } } });
  await prisma.barberDayLock.deleteMany({
    where: { barber: { user: { email: { in: EMAILS } } } },
  });
  await prisma.barberSchedule.deleteMany({
    where: { barber: { user: { email: { in: EMAILS } } } },
  });
  await prisma.barberService.deleteMany({ where: { service: { name: { startsWith: PREFIX } } } });
  await prisma.barber.deleteMany({ where: { user: { email: { in: EMAILS } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.service.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.client.deleteMany({ where: { phoneE164: { in: PHONES } } });
}

async function reseed() {
  await cleanup();

  await prisma.shopSettings.upsert({
    where: { id: 1 },
    update: {
      timezone: TIMEZONE,
      bufferMinutes: 0,
      minimumNoticeMinutes: 60,
      bookingHorizonDays: 365,
      onlineBookingEnabled: true,
    },
    create: { id: 1, name: 'Francis Cutz', timezone: TIMEZONE, bookingHorizonDays: 365 },
  });

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: PASSWORD_HASH,
      firstName: 'Online',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });

  const barberUser = await prisma.user.create({
    data: {
      email: BARBER_EMAIL,
      passwordHash: PASSWORD_HASH,
      firstName: 'Ontest',
      lastName: 'Barber',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });
  const barber = await prisma.barber.create({
    data: { userId: barberUser.id, displayName: 'Ontest Marcus', slug: `ontest-${barberUser.id}` },
  });
  barberId = barber.id;

  await prisma.barberSchedule.create({
    data: { barberId, dayOfWeek: 2, startMinute: 600, endMinute: 1080 },
  });

  const cut = await prisma.service.create({
    data: { name: `${PREFIX}Haircut`, priceCents: 4500, durationMinutes: 45 },
  });
  cutId = cut.id;
  await prisma.barberService.create({ data: { barberId, serviceId: cutId } });
}

/** What the public site sends: no price, no duration, no source. */
function publicBooking(overrides: Record<string, unknown> = {}) {
  return {
    barberId,
    serviceIds: [cutId],
    startAt: SLOT.toISOString(),
    phone: CLIENT_PHONE,
    firstName: 'Public',
    lastName: 'Booker',
    ...overrides,
  };
}

/** The staff path, exercised directly so the contrast is unambiguous. */
function staffBooking(overrides: Record<string, unknown> = {}) {
  return {
    barberId,
    serviceIds: [cutId],
    startAt: SLOT,
    client: { phone: CLIENT_PHONE, firstName: 'Desk' },
    source: 'STAFF' as const,
    enforceMinimumNotice: false,
    enforceOnlineRules: false,
    now: NOW,
    ...overrides,
  };
}


afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('the shop-wide online switch', () => {
  beforeEach(reseed);

  it('refuses a public booking when online booking is switched off', async () => {
    await prisma.shopSettings.update({ where: { id: 1 }, data: { onlineBookingEnabled: false } });

    const response = await request(server).post('/api/appointments').send(publicBooking());

    expect(response.status).toBe(400);
    // A message meant to be read by whoever is standing there holding a phone.
    expect(response.body.error.message).toMatch(/online booking is closed/i);
  });

  /**
   * The half a careless implementation gets wrong. "Online booking is off" is a
   * statement about the internet, not about the shop — the desk must keep working.
   */
  it('still lets staff book over the counter with it switched off', async () => {
    await prisma.shopSettings.update({ where: { id: 1 }, data: { onlineBookingEnabled: false } });

    const appointment = await createAppointment(staffBooking());
    expect(appointment.id).toBeTruthy();
  });

  it('takes a public booking when it is switched on', async () => {
    const response = await request(server).post('/api/appointments').send(publicBooking());
    expect(response.status).toBe(201);
    expect(response.body.booking.cancelToken).toBeTruthy();
  });
});

describe.skipIf(!reachable)('per-service and per-barber switches', () => {
  beforeEach(reseed);

  it('refuses a service the shop does not sell online', async () => {
    await prisma.service.update({ where: { id: cutId }, data: { bookableOnline: false } });

    const response = await request(server).post('/api/appointments').send(publicBooking());

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/booked by phone/i);
  });

  it('still lets staff book that service', async () => {
    await prisma.service.update({ where: { id: cutId }, data: { bookableOnline: false } });
    await expect(createAppointment(staffBooking())).resolves.toMatchObject({ barberId });
  });

  it('refuses a barber who is not taking online bookings', async () => {
    await prisma.barber.update({ where: { id: barberId }, data: { acceptsOnline: false } });

    const response = await request(server).post('/api/appointments').send(publicBooking());

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/not taking online bookings/i);
  });

  it('still lets staff book that barber', async () => {
    await prisma.barber.update({ where: { id: barberId }, data: { acceptsOnline: false } });
    await expect(createAppointment(staffBooking())).resolves.toMatchObject({ barberId });
  });

  /**
   * The list endpoints deliberately do NOT filter on these flags: the kiosk reads the
   * same two routes and needs the walk-in-only rows. Display is the client's job; the
   * refusal above is the boundary.
   */
  it('still lists an online-disabled service, because the kiosk needs it', async () => {
    await prisma.service.update({ where: { id: cutId }, data: { bookableOnline: false } });

    const response = await request(server).get('/api/services').expect(200);
    const service = response.body.services.find((row: { id: string }) => row.id === cutId);

    expect(service).toBeTruthy();
    // Flagged so the client can filter, rather than silently missing.
    expect(service.bookableOnline).toBe(false);
  });
});

describe.skipIf(!reachable)('reading a booking back by its token', () => {
  beforeEach(reseed);

  it('describes the appointment the cancel link refers to', async () => {
    const created = await request(server).post('/api/appointments').send(publicBooking()).expect(201);
    const { cancelToken } = created.body.booking;

    const response = await request(server)
      .get(`/api/appointments/token/${cancelToken}`)
      .expect(200);

    expect(response.body.booking.appointmentId).toBe(created.body.booking.appointmentId);
    expect(response.body.booking.barberName).toBe('Ontest Marcus');
    expect(response.body.booking.priceCentsTotal).toBe(4500);
    expect(response.body.status).toBe('BOOKED');
  });

  it('carries nothing the link holder did not already know', async () => {
    const created = await request(server).post('/api/appointments').send(publicBooking()).expect(201);

    const response = await request(server)
      .get(`/api/appointments/token/${created.body.booking.cancelToken}`)
      .expect(200);

    const payload = JSON.stringify(response.body);
    // Their own phone and surname are theirs, but there is no reason to echo them —
    // and a shared link should not hand them to whoever it was shared with.
    expect(payload).not.toContain(CLIENT_PHONE);
    expect(payload).not.toContain('Booker');
  });

  it('gives a plain not-found for a wrong token, revealing nothing', async () => {
    const response = await request(server).get('/api/appointments/token/not-a-real-token');

    expect(response.status).toBe(404);
    expect(response.body.error.message).toMatch(/not valid/i);
  });

  it('shows a cancelled appointment as cancelled rather than pretending it is gone', async () => {
    const created = await request(server).post('/api/appointments').send(publicBooking()).expect(201);
    const { cancelToken } = created.body.booking;

    await request(server).post(`/api/appointments/cancel/${cancelToken}`).expect(204);

    const response = await request(server)
      .get(`/api/appointments/token/${cancelToken}`)
      .expect(200);
    // So the page can say "this was already cancelled" instead of offering to cancel
    // it again and failing with a 409.
    expect(response.body.status).toBe('CANCELLED');
  });
});

describe.skipIf(!reachable)('availability still answers while booking is closed', () => {
  beforeEach(reseed);

  /**
   * Deliberate: the switch stops bookings being taken, not the shop's hours being
   * readable. The site can still show when they are open and say why it cannot book.
   */
  it('lists slots even with online booking switched off', async () => {
    await prisma.shopSettings.update({ where: { id: 1 }, data: { onlineBookingEnabled: false } });

    const date = DateTime.fromJSDate(SLOT).setZone(TIMEZONE).toFormat('yyyy-MM-dd');
    const response = await request(server)
      .get('/api/availability')
      .query({ barberId, date, serviceIds: cutId })
      .expect(200);

    expect(response.body.slots.length).toBeGreaterThan(0);
  });

  it('exposes the switch so the site can say so before anyone fills in a form', async () => {
    await prisma.shopSettings.update({ where: { id: 1 }, data: { onlineBookingEnabled: false } });

    const response = await request(server).get('/api/shop-settings').expect(200);
    expect(response.body.settings.onlineBookingEnabled).toBe(false);
  });
});
