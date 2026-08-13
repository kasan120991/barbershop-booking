/**
 * The server-side "next opening" fan-out.
 *
 * Database-backed, and in its own file rather than in `availability.test.ts` — that one
 * is deliberately pure, exercising the engine against hand-built snapshots with no
 * database at all. This half is the loader: which barbers are eligible, which day gets
 * scanned, and where the scan stops. Fixtures namespaced to `@nextavail.test`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../lib/prisma.js';
import { createAppointment } from './booking.js';
import { findNextAvailable } from './availability.js';
import { hashPassword } from './passwords.js';

const PREFIX = 'NEXTAVAIL ';
const CUTTER_EMAIL = 'cutter@nextavail.test';
const COLOURIST_EMAIL = 'colourist@nextavail.test';
const EMAILS = [CUTTER_EMAIL, COLOURIST_EMAIL];
const CLIENT_PHONE = '+14155550401';
const OTHER_PHONE = '+14155550402';

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

/** Works Tuesdays. Does both services. */
let cutterId = '';
/** Works Tuesdays too, but only ever does the haircut. */
let colouristId = '';
let haircutId = '';
let colourId = '';

async function cleanup() {
  await prisma.appointmentService.deleteMany({
    where: { appointment: { barber: { user: { email: { in: EMAILS } } } } },
  });
  await prisma.appointment.deleteMany({
    where: { barber: { user: { email: { in: EMAILS } } } },
  });
  await prisma.barberDayLock.deleteMany({
    where: { barber: { user: { email: { in: EMAILS } } } },
  });
  await prisma.barberSchedule.deleteMany({
    where: { barber: { user: { email: { in: EMAILS } } } },
  });
  await prisma.scheduleException.deleteMany({
    where: { barber: { user: { email: { in: EMAILS } } } },
  });
  await prisma.barberService.deleteMany({ where: { service: { name: { startsWith: PREFIX } } } });
  await prisma.barber.deleteMany({ where: { user: { email: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.service.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.client.deleteMany({ where: { phoneE164: { in: [CLIENT_PHONE, OTHER_PHONE] } } });
}

async function makeBarber(email: string, displayName: string, sortOrder: number) {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword('FrancisCutz!2026'),
      firstName: displayName,
      lastName: 'Nextavail',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  const barber = await prisma.barber.create({
    data: { userId: user.id, displayName, slug: `${displayName.toLowerCase()}-${user.id}`, sortOrder },
  });

  // Tuesdays 10:00–18:00 local, no break, so the arithmetic stays obvious.
  await prisma.barberSchedule.create({
    data: { barberId: barber.id, dayOfWeek: 2, startMinute: 600, endMinute: 1080 },
  });

  return barber.id;
}

async function reseed() {
  await cleanup();

  await prisma.shopSettings.upsert({
    where: { id: 1 },
    update: {
      timezone: 'America/New_York',
      slotGranularityMinutes: 15,
      bufferMinutes: 0,
      minimumNoticeMinutes: 60,
      bookingHorizonDays: 365,
    },
    create: { id: 1, name: 'Francis Cutz', timezone: 'America/New_York', bookingHorizonDays: 365 },
  });

  /**
   * `ShopHours` is deliberately NOT touched.
   *
   * It is shop-wide, shared with every other file in the suite, and the standing rule is
   * that a test only ever deletes or updates its own fixtures. Rewriting Tuesday here
   * left it open two hours later than the seed for whichever file ran next. The barbers
   * below work 10:00–18:00 and the shop's seeded Tuesday is 9:00–17:00, so the
   * intersection is a full seven-hour day — more than these assertions need.
   */

  // Sort order decides which chair "any barber" offers on a tie, so it is pinned.
  cutterId = await makeBarber(CUTTER_EMAIL, 'Cutter', 1);
  colouristId = await makeBarber(COLOURIST_EMAIL, 'Colourist', 2);

  const haircut = await prisma.service.create({
    data: { name: `${PREFIX}Haircut`, priceCents: 4500, durationMinutes: 45 },
  });
  haircutId = haircut.id;

  const colour = await prisma.service.create({
    data: { name: `${PREFIX}Colour`, priceCents: 12000, durationMinutes: 60 },
  });
  colourId = colour.id;

  await prisma.barberService.createMany({
    data: [
      { barberId: cutterId, serviceId: haircutId },
      { barberId: cutterId, serviceId: colourId },
      // The colourist deliberately does NOT do the colour, so a fan-out that ignored
      // capability would offer a chair that cannot finish the job.
      { barberId: colouristId, serviceId: haircutId },
    ],
  });
}

/** 2026-08-11 is a Tuesday. 10:00 local is 14:00Z in August. */
const TUESDAY = '2026-08-11';
const TEN_AM = new Date('2026-08-11T14:00:00.000Z');
/** A week earlier, so nothing is inside the notice window. */
const NOW = new Date('2026-08-04T12:00:00.000Z');

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('findNextAvailable', () => {
  beforeEach(reseed);

  it('names a concrete barber on every offer', async () => {
    const result = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      enforceOnlineRules: false,
      now: NOW,
    });

    expect(result.reason).toBeNull();
    expect(result.durationMinutes).toBe(45);
    expect(result.offers.length).toBeGreaterThan(0);

    // Picking a time picks a person. There is no such thing as an unassigned offer.
    for (const offer of result.offers) {
      expect([cutterId, colouristId]).toContain(offer.barberId);
      expect(offer.barberName).toBeTruthy();
    }
  });

  /**
   * The bug this pins was found by ringing the thing rather than by a unit test: a
   * three-chair shop that opens at ten answered "ten o'clock with Kasan, ten o'clock with
   * Andre, or ten o'clock with Rico" — one option read out three times.
   */
  it('offers one chair per distinct time when no barber was asked for', async () => {
    const result = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      limit: 3,
      enforceOnlineRules: false,
      now: NOW,
    });

    const times = result.offers.map((offer) => offer.startAt.getTime());
    expect(new Set(times).size).toBe(times.length);

    // The first slot goes to the lower `sortOrder` — the chair the shop itself would offer.
    expect(result.offers[0]?.barberId).toBe(cutterId);
  });

  it('does not dedupe when a specific barber was asked for', async () => {
    const result = await findNextAvailable({
      serviceIds: [haircutId],
      barberId: colouristId,
      fromDate: TUESDAY,
      limit: 3,
      enforceOnlineRules: false,
      now: NOW,
    });

    // Every offer is theirs, and their own times are distinct anyway.
    expect(result.offers).toHaveLength(3);
    expect(result.offers.every((offer) => offer.barberId === colouristId)).toBe(true);
  });

  it('excludes a barber who does not do every requested service', async () => {
    const result = await findNextAvailable({
      serviceIds: [colourId],
      fromDate: TUESDAY,
      limit: 10,
      enforceOnlineRules: false,
      now: NOW,
    });

    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every((offer) => offer.barberId === cutterId)).toBe(true);
  });

  it('needs one barber to do the WHOLE basket, not one service each', async () => {
    // Cutter does both; Colourist does only the haircut. Asking for both must not
    // assemble a chair out of two people.
    const result = await findNextAvailable({
      serviceIds: [haircutId, colourId],
      fromDate: TUESDAY,
      limit: 10,
      enforceOnlineRules: false,
      now: NOW,
    });

    expect(result.offers.every((offer) => offer.barberId === cutterId)).toBe(true);
    expect(result.durationMinutes).toBe(105);
  });

  it('says so when nobody does the whole basket', async () => {
    await prisma.barberService.deleteMany({
      where: { barberId: cutterId, serviceId: colourId },
    });

    const result = await findNextAvailable({
      serviceIds: [colourId],
      fromDate: TUESDAY,
      enforceOnlineRules: false,
      now: NOW,
    });

    expect(result.offers).toHaveLength(0);
    expect(result.reason).toMatch(/no barber on today does all of those/i);
  });

  it('honours an explicit barber, and refuses one who cannot do the work', async () => {
    const mine = await findNextAvailable({
      serviceIds: [haircutId],
      barberId: colouristId,
      fromDate: TUESDAY,
      limit: 10,
      enforceOnlineRules: false,
      now: NOW,
    });
    expect(mine.offers.every((offer) => offer.barberId === colouristId)).toBe(true);

    const impossible = await findNextAvailable({
      serviceIds: [colourId],
      barberId: colouristId,
      fromDate: TUESDAY,
      enforceOnlineRules: false,
      now: NOW,
    });
    expect(impossible.offers).toHaveLength(0);
    expect(impossible.reason).toMatch(/does not do all of those/i);
  });

  it('rolls forward to the next working day when a day is empty', async () => {
    // Wednesday: nobody has a Wednesday shift, so the scan must walk to next Tuesday.
    const result = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: '2026-08-12',
      enforceOnlineRules: false,
      now: NOW,
    });

    expect(result.reason).toBeNull();
    expect(result.offers.length).toBeGreaterThan(0);
    // 2026-08-18 is the following Tuesday.
    expect(result.offers[0]?.startAt.toISOString()).toBe('2026-08-18T14:00:00.000Z');
  });

  it('keeps every offer on one day, so the answer is speakable', async () => {
    const result = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      limit: 3,
      enforceOnlineRules: false,
      now: NOW,
    });

    const days = new Set(result.offers.map((offer) => offer.startAt.toISOString().slice(0, 10)));
    expect(days.size).toBe(1);
  });

  it('skips a chair that is already booked and offers the other one', async () => {
    await createAppointment({
      barberId: cutterId,
      serviceIds: [haircutId],
      startAt: TEN_AM,
      client: { phone: CLIENT_PHONE, firstName: 'Booked' },
      source: 'ONLINE',
      enforceMinimumNotice: false,
      enforceOnlineRules: false,
      now: NOW,
    });

    const result = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      limit: 1,
      enforceOnlineRules: false,
      now: NOW,
    });

    // 10:00 is gone on Cutter's book but not on Colourist's.
    expect(result.offers[0]?.startAt.toISOString()).toBe(TEN_AM.toISOString());
    expect(result.offers[0]?.barberId).toBe(colouristId);
  });

  it('respects `after` for "later today" and "after four"', async () => {
    // 15:00 local on the Tuesday is 19:00Z.
    const after = new Date('2026-08-11T19:00:00.000Z');

    const result = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      after,
      limit: 5,
      enforceOnlineRules: false,
      now: NOW,
    });

    expect(result.offers.length).toBeGreaterThan(0);
    for (const offer of result.offers) {
      expect(offer.startAt.getTime()).toBeGreaterThanOrEqual(after.getTime());
    }
  });

  it('never scans a day that has already gone', async () => {
    const result = await findNextAvailable({
      serviceIds: [haircutId],
      // Long before `now`. "Next available from last month" means from today.
      fromDate: '2026-07-01',
      enforceOnlineRules: false,
      now: NOW,
    });

    for (const offer of result.offers) {
      expect(offer.startAt.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('stops at the booking horizon and says the shop’s own sentence', async () => {
    await prisma.shopSettings.update({ where: { id: 1 }, data: { bookingHorizonDays: 1 } });

    const result = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      enforceOnlineRules: false,
      now: NOW,
    });

    expect(result.offers).toHaveLength(0);
    expect(result.reason).toMatch(/only open 1 days ahead/i);
  });

  it('gives up after `maxDays` with a bounded answer rather than scanning forever', async () => {
    await prisma.barberSchedule.deleteMany({
      where: { barber: { user: { email: { in: EMAILS } } } },
    });

    const result = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      maxDays: 3,
      enforceOnlineRules: false,
      now: NOW,
    });

    expect(result.offers).toHaveLength(0);
    expect(result.reason).toBeTruthy();
  });

  /**
   * Both halves, per the standing rule: the online switches govern the internet and the
   * phone ignores them. A test asserting only one half lets the other silently invert.
   */
  it('applies the online rules only when asked to', async () => {
    await prisma.service.update({
      where: { id: haircutId },
      data: { bookableOnline: false },
    });

    await expect(
      findNextAvailable({
        serviceIds: [haircutId],
        fromDate: TUESDAY,
        enforceOnlineRules: true,
        now: NOW,
      }),
    ).rejects.toThrow(/has to be booked by phone/i);

    const byPhone = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      enforceOnlineRules: false,
      now: NOW,
    });
    expect(byPhone.offers.length).toBeGreaterThan(0);
  });

  it('drops a barber who is not taking online bookings, but only online', async () => {
    await prisma.barber.update({ where: { id: cutterId }, data: { acceptsOnline: false } });

    const online = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      limit: 10,
      enforceOnlineRules: true,
      now: NOW,
    });
    expect(online.offers.every((offer) => offer.barberId === colouristId)).toBe(true);

    const byPhone = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      limit: 10,
      enforceOnlineRules: false,
      now: NOW,
    });
    expect(byPhone.offers.some((offer) => offer.barberId === cutterId)).toBe(true);
  });

  it('ignores an inactive barber entirely', async () => {
    await prisma.barber.update({ where: { id: cutterId }, data: { status: 'INACTIVE' } });

    const result = await findNextAvailable({
      serviceIds: [haircutId],
      fromDate: TUESDAY,
      limit: 10,
      enforceOnlineRules: false,
      now: NOW,
    });

    expect(result.offers.every((offer) => offer.barberId === colouristId)).toBe(true);
  });

  it('refuses a service that no longer exists', async () => {
    await expect(
      findNextAvailable({
        serviceIds: ['not-a-real-service'],
        fromDate: TUESDAY,
        enforceOnlineRules: false,
        now: NOW,
      }),
    ).rejects.toThrow(/no longer exists/i);
  });
});
