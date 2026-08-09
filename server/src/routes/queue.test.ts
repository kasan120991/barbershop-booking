/**
 * The walk-in queue, against a real database.
 *
 * The estimator's arithmetic is covered purely in `services/queue.test.ts`. What can
 * only be proved here is everything that involves the database or the wire: the
 * duplicate guard, the `callNext` row lock, who is allowed to see a phone number, and
 * the claim this whole phase rests on — that a walk-in actually removes time from the
 * online booking calendar.
 *
 * Fixtures are namespaced to `@queue.test` with cleanup scoped through the relations,
 * because the suite shares one database with every other file.
 *
 * Two schedules are seeded for the same barber on purpose. The service-level tests run
 * against a fixed Tuesday with an injected clock, so their assertions are arithmetic
 * rather than whatever time the suite happens to run at; the HTTP tests run against
 * the real clock and need the barber to be working *now*, so today gets a shift too.
 */

import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_HEADER, DEVICE_TOKEN_HEADER } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';
import { getAvailability } from '../services/availability.js';
import { hashPassword } from '../services/passwords.js';
import {
  assignQueueBarber,
  callNext,
  getQueueBoard,
  joinQueue,
  setQueuePriority,
  updateQueueStatus,
} from '../services/queue.js';

const app = createApp();

const PREFIX = 'QTEST ';
const PASSWORD = 'FrancisCutz!2026';
const ADMIN_EMAIL = 'admin@queue.test';
const BARBER_EMAIL = 'barber@queue.test';
const SECOND_BARBER_EMAIL = 'second@queue.test';
const EMAILS = [ADMIN_EMAIL, BARBER_EMAIL, SECOND_BARBER_EMAIL];

const ALICE = '+14155550401';
const BOB = '+14155550402';
const CARLA = '+14155550403';
const RACER_ONE = '+14155550404';
const RACER_TWO = '+14155550405';
const PHONES = [ALICE, BOB, CARLA, RACER_ONE, RACER_TWO];

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

/**
 * Hashed once for the whole file rather than per fixture.
 *
 * This file seeds three accounts and `beforeEach` re-runs for every test, so hashing
 * inside `reseed` would be a hundred argon2 passes. Argon2 is memory-hard on purpose;
 * repeating it that many times slows the shared suite for no coverage — the password
 * path has its own tests in `passwords.test.ts`.
 */
const PASSWORD_HASH = await hashPassword(PASSWORD);

let barberId = '';
let secondBarberId = '';
let cutId = '';
let beardId = '';

/** 2026-08-11 is a Tuesday; the shop's zone is UTC-4 in August. */
const TUESDAY = '2026-08-11';
/** 10:00 local on that Tuesday — the moment the barber's shift starts. */
const NOW = new Date('2026-08-11T14:00:00.000Z');

const TIMEZONE = 'America/New_York';
/** Whatever weekday the suite happens to run on, for the HTTP tests. */
const todayWeekday = DateTime.now().setZone(TIMEZONE).weekday % 7;

async function cleanup() {
  await prisma.queueEntryService.deleteMany({
    where: { queueEntry: { client: { phoneE164: { in: PHONES } } } },
  });
  await prisma.queueEntry.deleteMany({ where: { client: { phoneE164: { in: PHONES } } } });
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
  await prisma.device.deleteMany({ where: { label: { startsWith: PREFIX } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.service.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.client.deleteMany({ where: { phoneE164: { in: PHONES } } });
  // The all-day row this file adds for today. Removed so the shared `shop_hours`
  // table is left exactly as it was found.
  await prisma.shopHours.deleteMany({ where: { dayOfWeek: todayWeekday, openMinute: 0 } });
}

async function makeBarber(email: string, name: string, sortOrder: number) {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: PASSWORD_HASH,
      firstName: name,
      lastName: 'Queuetest',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  const barber = await prisma.barber.create({
    data: { userId: user.id, displayName: name, slug: `qtest-${user.id}`, sortOrder },
  });

  // Tuesday 10:00–18:00 for the fixed-clock tests...
  await prisma.barberSchedule.create({
    data: { barberId: barber.id, dayOfWeek: 2, startMinute: 600, endMinute: 1080 },
  });
  // ...and all of today, so the HTTP tests find them working whenever this runs.
  await prisma.barberSchedule.create({
    data: { barberId: barber.id, dayOfWeek: todayWeekday, startMinute: 0, endMinute: 1440 },
  });

  return barber.id;
}

async function reseed() {
  await cleanup();

  await prisma.shopSettings.upsert({
    where: { id: 1 },
    update: {
      timezone: TIMEZONE,
      slotGranularityMinutes: 15,
      bufferMinutes: 0,
      minimumNoticeMinutes: 0,
      bookingHorizonDays: 365,
      walkInQueueEnabled: true,
    },
    create: { id: 1, name: 'Francis Cutz', timezone: TIMEZONE, bookingHorizonDays: 365 },
  });

  // Tuesday must be open for the fixed-clock tests; this matches what is already
  // seeded rather than widening it, so nothing else sees a different Tuesday.
  await prisma.shopHours.upsert({
    where: { dayOfWeek_openMinute: { dayOfWeek: 2, openMinute: 540 } },
    update: { closeMinute: 1020, isClosed: false },
    create: { dayOfWeek: 2, openMinute: 540, closeMinute: 1020, isClosed: false },
  });
  // And today must be open around the clock, whenever "now" happens to be.
  await prisma.shopHours.create({
    data: { dayOfWeek: todayWeekday, openMinute: 0, closeMinute: 1440, isClosed: false },
  });

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: PASSWORD_HASH,
      firstName: 'Queue',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });

  barberId = await makeBarber(BARBER_EMAIL, 'Qtest Marcus', 0);
  secondBarberId = await makeBarber(SECOND_BARBER_EMAIL, 'Qtest Dee', 1);

  const cut = await prisma.service.create({
    data: { name: `${PREFIX}Haircut`, priceCents: 4500, durationMinutes: 30 },
  });
  const beard = await prisma.service.create({
    data: { name: `${PREFIX}Beard`, priceCents: 2000, durationMinutes: 15 },
  });
  cutId = cut.id;
  beardId = beard.id;

  // Both barbers cut; only the first does beards, which is what makes the
  // "anyone will do" eligibility test mean something.
  await prisma.barberService.createMany({
    data: [
      { barberId, serviceId: cutId },
      { barberId, serviceId: beardId },
      { barberId: secondBarberId, serviceId: cutId },
    ],
  });
}

function walkIn(overrides: Record<string, unknown> = {}) {
  return {
    client: { phone: ALICE, firstName: 'Alice', lastName: 'Anderson' },
    serviceIds: [cutId],
    source: 'KIOSK' as const,
    now: NOW,
    ...overrides,
  };
}

async function session(email: string) {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  return {
    cookies: response.headers['set-cookie'] as unknown as string[],
    csrfToken: response.body.csrfToken as string,
  };
}

/** Pairs a kiosk and returns its bearer token. */
async function kioskToken(): Promise<string> {
  const admin = await session(ADMIN_EMAIL);
  const created = await request(app)
    .post('/api/devices')
    .set('Cookie', admin.cookies)
    .set(CSRF_HEADER, admin.csrfToken)
    .send({ label: `${PREFIX}Front counter`, type: 'KIOSK' })
    .expect(201);

  const paired = await request(app)
    .post('/api/devices/pair')
    .send({ pairingCode: created.body.pairingCode })
    .expect(200);

  return paired.body.deviceToken as string;
}

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('joining the queue', () => {
  beforeEach(reseed);

  it('snapshots price and duration from the service rows', async () => {
    const { entry } = await joinQueue(walkIn({ serviceIds: [cutId, beardId] }));

    expect(entry.durationMinutes).toBe(45);
    expect(entry.priceCentsTotal).toBe(6500);
    expect(entry.services.map((service) => service.nameSnapshot).sort()).toEqual([
      `${PREFIX}Beard`,
      `${PREFIX}Haircut`,
    ]);
  });

  it('keeps the snapshot when the menu changes afterwards', async () => {
    const { entry } = await joinQueue(walkIn());
    await prisma.service.update({ where: { id: cutId }, data: { priceCents: 9900 } });

    const reloaded = await prisma.queueEntry.findUnique({
      where: { id: entry.id },
      include: { services: true },
    });

    expect(reloaded?.priceCentsTotal).toBe(4500);
    expect(reloaded?.services[0]?.priceCents).toBe(4500);
  });

  it('refuses a second active entry for the same person', async () => {
    await joinQueue(walkIn());
    // A kiosk double-tap and a deliberate re-join look identical from here.
    await expect(joinQueue(walkIn())).rejects.toThrow(/already in the queue/i);
  });

  it('lets someone rejoin once their previous visit is finished', async () => {
    const { entry } = await joinQueue(walkIn());
    await updateQueueStatus(entry.id, 'CANCELLED', NOW);

    const again = await joinQueue(walkIn());
    expect(again.entry.id).not.toBe(entry.id);
  });

  it('refuses a service the shop does not take as a walk-in', async () => {
    await prisma.service.update({ where: { id: cutId }, data: { bookableWalkIn: false } });
    await expect(joinQueue(walkIn())).rejects.toThrow(/booked in advance/i);
  });

  it('refuses everyone when walk-ins are switched off', async () => {
    await prisma.shopSettings.update({ where: { id: 1 }, data: { walkInQueueEnabled: false } });
    await expect(joinQueue(walkIn())).rejects.toThrow(/not taking walk-ins/i);
  });

  it('refuses a barber who does not do all of those services', async () => {
    await expect(
      joinQueue(walkIn({ barberId: secondBarberId, serviceIds: [cutId, beardId] })),
    ).rejects.toThrow(/does not do all/i);
  });

  it('normalises the phone so one person is not two clients', async () => {
    await joinQueue(walkIn());
    const { entry } = await joinQueue(
      walkIn({ client: { phone: '(415) 555-0402', firstName: 'Bob' } }),
    );

    expect(entry.client.phoneE164).toBe(BOB);
    expect(await prisma.client.count({ where: { phoneE164: ALICE } })).toBe(1);
  });
});

describe.skipIf(!reachable)('the board', () => {
  beforeEach(reseed);

  it('numbers the line by arrival and renumbers it after a bump', async () => {
    const first = await joinQueue(walkIn({ now: NOW }));
    const second = await joinQueue(
      walkIn({ client: { phone: BOB, firstName: 'Bob' }, now: new Date(NOW.getTime() + 60_000) }),
    );

    const before = await getQueueBoard({ now: NOW });
    expect(positionOf(before, first.entry.id)).toBe(1);
    expect(positionOf(before, second.entry.id)).toBe(2);

    await setQueuePriority(second.entry.id, 5, NOW);

    const after = await getQueueBoard({ now: NOW });
    expect(positionOf(after, second.entry.id)).toBe(1);
    expect(positionOf(after, first.entry.id)).toBe(2);
  });

  it('sends an "anyone" walk-in to the chair that frees up first', async () => {
    // Three cuts, two chairs: the third has to wait for one of them.
    const a = await joinQueue(walkIn({ now: NOW }));
    const b = await joinQueue(
      walkIn({ client: { phone: BOB, firstName: 'Bob' }, now: new Date(NOW.getTime() + 1000) }),
    );
    const c = await joinQueue(
      walkIn({ client: { phone: CARLA, firstName: 'Carla' }, now: new Date(NOW.getTime() + 2000) }),
    );

    const board = await getQueueBoard({ now: NOW });
    const assigned = (id: string) =>
      board.entries.find((row) => row.entry.id === id)?.assignment?.assignedBarberId;

    expect(new Set([assigned(a.entry.id), assigned(b.entry.id)])).toEqual(
      new Set([barberId, secondBarberId]),
    );
    // Both chairs are busy for half an hour, so the third is quoted 10:30.
    expect(readyAt(board, c.entry.id)).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
  });

  it('will not put a beard trim in the chair of a barber who does not do beards', async () => {
    const { entry } = await joinQueue(walkIn({ serviceIds: [cutId, beardId], now: NOW }));
    const board = await getQueueBoard({ now: NOW });

    expect(
      board.entries.find((row) => row.entry.id === entry.id)?.assignment?.assignedBarberId,
    ).toBe(barberId);
  });

  it('persists the estimate so availability can read it', async () => {
    const { entry } = await joinQueue(walkIn({ now: NOW }));
    const stored = await prisma.queueEntry.findUnique({ where: { id: entry.id } });

    expect(stored?.estimatedReadyAt?.toISOString()).toBe(NOW.toISOString());
  });

  /**
   * The distinction a chair card lives or dies on: a barber with an empty chair is
   * available NOW, even with people pencilled in for later.
   */
  it('reports a chair as free now even with a queue pencilled into it', async () => {
    await joinQueue(walkIn({ barberId, now: NOW }));
    await joinQueue(
      walkIn({
        client: { phone: BOB, firstName: 'Bob' },
        barberId,
        now: new Date(NOW.getTime() + 1000),
      }),
    );

    const board = await getQueueBoard({ now: NOW });
    const chair = board.chairs.find((row) => row.barberId === barberId);

    expect(chair?.freeFrom?.toISOString()).toBe(NOW.toISOString());
    expect(chair?.waitingCount).toBe(2);
  });
});

describe.skipIf(!reachable)('the queue and the calendar share one day', () => {
  beforeEach(reseed);

  /**
   * The claim this whole phase rests on. If it fails, the shop sells the same half
   * hour twice — once at the door and once online — and nobody finds out until two
   * people are standing in front of one chair.
   */
  it('a walk-in removes the time it was promised from online availability', async () => {
    const before = await getAvailability({
      barberId,
      date: TUESDAY,
      serviceIds: [cutId],
      now: NOW,
    });
    expect(before.slots.map((slot) => slot.toISOString())).toContain(NOW.toISOString());

    // Named barber, so the commitment attaches to this chair rather than floating.
    await joinQueue(walkIn({ barberId, now: NOW }));

    const after = await getAvailability({
      barberId,
      date: TUESDAY,
      serviceIds: [cutId],
      now: NOW,
    });

    expect(after.slots.map((slot) => slot.toISOString())).not.toContain(NOW.toISOString());
    expect(after.slots.length).toBeLessThan(before.slots.length);
  });

  it('gives the time back when the walk-in leaves', async () => {
    const { entry } = await joinQueue(walkIn({ barberId, now: NOW }));
    await updateQueueStatus(entry.id, 'CANCELLED', NOW);

    const after = await getAvailability({
      barberId,
      date: TUESDAY,
      serviceIds: [cutId],
      now: NOW,
    });
    expect(after.slots.map((slot) => slot.toISOString())).toContain(NOW.toISOString());
  });

  it('schedules a walk-in around an appointment already booked online', async () => {
    // 10:00–10:45 is spoken for, so a 30-minute walk-in cannot start before 10:45.
    await prisma.appointment.create({
      data: {
        clientId: (
          await prisma.client.create({
            data: { phoneE164: CARLA, firstName: 'Carla' },
          })
        ).id,
        barberId,
        startAt: NOW,
        endAt: new Date(NOW.getTime() + 45 * 60_000),
        durationMinutes: 45,
        priceCentsTotal: 4500,
      },
    });

    const { entry } = await joinQueue(walkIn({ barberId, now: NOW }));
    const board = await getQueueBoard({ now: NOW });

    expect(readyAt(board, entry.id)).toBe(new Date(NOW.getTime() + 45 * 60_000).toISOString());
  });
});

describe.skipIf(!reachable)('calling and seating', () => {
  beforeEach(reseed);

  it('claims an "anyone" walk-in for the barber who called them', async () => {
    const { entry } = await joinQueue(walkIn({ now: NOW }));
    expect(entry.barberId).toBeNull();

    const called = await callNext(secondBarberId, NOW);

    expect(called.entry.id).toBe(entry.id);
    expect(called.entry.barberId).toBe(secondBarberId);
    expect(called.entry.status).toBe('CALLED');
    expect(called.entry.calledAt).not.toBeNull();
  });

  it('skips a walk-in whose services the calling barber does not do', async () => {
    const beardClient = await joinQueue(walkIn({ serviceIds: [cutId, beardId], now: NOW }));
    const cutClient = await joinQueue(
      walkIn({
        client: { phone: BOB, firstName: 'Bob' },
        now: new Date(NOW.getTime() + 60_000),
      }),
    );

    // Dee does not do beards, so she gets the person behind, not the person in front.
    const called = await callNext(secondBarberId, NOW);
    expect(called.entry.id).toBe(cutClient.entry.id);
    expect(called.entry.id).not.toBe(beardClient.entry.id);
  });

  it('says so plainly when there is nobody waiting', async () => {
    await expect(callNext(barberId, NOW)).rejects.toThrow(/nobody is waiting/i);
  });

  it('walks the whole lifecycle and counts the visit', async () => {
    const { entry } = await joinQueue(walkIn({ barberId, now: NOW }));

    await updateQueueStatus(entry.id, 'CALLED', NOW);
    const seated = await updateQueueStatus(entry.id, 'IN_CHAIR', NOW);
    expect(seated.entry.startedAt).not.toBeNull();

    const done = await updateQueueStatus(entry.id, 'COMPLETED', NOW);
    expect(done.entry.completedAt).not.toBeNull();

    // `visitCount` and `lastVisitAt` have had no writer until now.
    const client = await prisma.client.findUnique({ where: { phoneE164: ALICE } });
    expect(client?.visitCount).toBe(1);
    expect(client?.lastVisitAt).not.toBeNull();
  });

  it('counts a no-show against the client instead', async () => {
    const { entry } = await joinQueue(walkIn({ barberId, now: NOW }));
    await updateQueueStatus(entry.id, 'NO_SHOW', NOW);

    const client = await prisma.client.findUnique({ where: { phoneE164: ALICE } });
    expect(client?.noShowCount).toBe(1);
    expect(client?.visitCount).toBe(0);
  });

  it('puts someone who wandered off back in the line without losing their place', async () => {
    const first = await joinQueue(walkIn({ now: NOW }));
    await joinQueue(
      walkIn({ client: { phone: BOB, firstName: 'Bob' }, now: new Date(NOW.getTime() + 60_000) }),
    );

    await updateQueueStatus(first.entry.id, 'CALLED', NOW);
    const back = await updateQueueStatus(first.entry.id, 'WAITING', NOW);

    expect(back.entry.status).toBe('WAITING');
    expect(back.entry.calledAt).toBeNull();
    // Their original arrival time is untouched, so they are still first.
    expect(positionOf(await getQueueBoard({ now: NOW }), first.entry.id)).toBe(1);
  });

  it('refuses a transition that makes no sense', async () => {
    const { entry } = await joinQueue(walkIn({ barberId, now: NOW }));
    await updateQueueStatus(entry.id, 'CANCELLED', NOW);

    await expect(updateQueueStatus(entry.id, 'IN_CHAIR', NOW)).rejects.toThrow(/cannot become/i);
  });

  it('will not seat somebody who has no barber yet', async () => {
    const { entry } = await joinQueue(walkIn({ now: NOW }));
    await expect(updateQueueStatus(entry.id, 'IN_CHAIR', NOW)).rejects.toThrow(/assign a barber/i);
  });

  it('moves someone to another chair when they can be served there', async () => {
    const { entry } = await joinQueue(walkIn({ barberId, now: NOW }));
    const moved = await assignQueueBarber(entry.id, secondBarberId, NOW);
    expect(moved.entry.barberId).toBe(secondBarberId);
  });

  it('refuses to move someone to a barber who cannot do their services', async () => {
    const { entry } = await joinQueue(walkIn({ barberId, serviceIds: [cutId, beardId], now: NOW }));
    await expect(assignQueueBarber(entry.id, secondBarberId, NOW)).rejects.toThrow(
      /does not do all/i,
    );
  });

  /**
   * The test the row lock exists for.
   *
   * Two barbers finish at the same moment and both tap "Next". Without
   * `SELECT ... FOR UPDATE` and the re-check inside it, both are handed the same
   * client — who is then called twice and seated once, while the person behind them
   * never moves. Run several times, because a race that only fails sometimes is
   * still broken. Verified by removing the lock and watching this go red.
   */
  it('never hands the same client to two barbers at once', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await reseed();

      // Different phone numbers, so the two joins do not serialise on the `clients`
      // unique key before the interesting part starts.
      const one = await joinQueue(
        walkIn({ client: { phone: RACER_ONE, firstName: 'One' }, now: NOW }),
      );
      const two = await joinQueue(
        walkIn({
          client: { phone: RACER_TWO, firstName: 'Two' },
          now: new Date(NOW.getTime() + 1000),
        }),
      );

      const results = await Promise.allSettled([
        callNext(barberId, NOW),
        callNext(secondBarberId, NOW),
      ]);

      const called = results
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value.entry.id);

      // Both barbers may well succeed — there are two people waiting. What must never
      // happen is both of them being handed the SAME one.
      expect(new Set(called).size).toBe(called.length);

      const stored = await prisma.queueEntry.findMany({
        where: { id: { in: [one.entry.id, two.entry.id] } },
        select: { id: true, barberId: true, status: true },
      });
      const claimedBy = stored.filter((row) => row.status === 'CALLED').map((row) => row.barberId);
      expect(new Set(claimedBy).size).toBe(claimedBy.length);
    }
  });
});

describe.skipIf(!reachable)('who may see what', () => {
  beforeEach(reseed);

  it('keeps the staff board away from an unauthenticated request', async () => {
    await request(app).get('/api/queue').expect(401);
  });

  it('keeps the staff board away from a kiosk, which has no roles at all', async () => {
    const token = await kioskToken();
    await request(app).get('/api/queue').set(DEVICE_TOKEN_HEADER, token).expect(401);
  });

  it('gives staff the phone number, because a wandering walk-in has to be callable', async () => {
    const staff = await session(BARBER_EMAIL);
    const token = await kioskToken();

    await request(app)
      .post('/api/queue')
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ phone: ALICE, firstName: 'Alice', lastName: 'Anderson', serviceIds: [cutId] })
      .expect(201);

    const board = await request(app).get('/api/queue').set('Cookie', staff.cookies).expect(200);

    expect(board.body.board.entries[0].clientPhone).toBe(ALICE);
    // Even for staff, the surname is an initial — this string ends up on shared screens.
    expect(board.body.board.entries[0].clientName).toBe('Alice A.');
  });

  it('never puts a phone number or a surname on the screen facing the room', async () => {
    const token = await kioskToken();

    await request(app)
      .post('/api/queue')
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ phone: ALICE, firstName: 'Alice', lastName: 'Anderson', serviceIds: [cutId] })
      .expect(201);

    const board = await request(app)
      .get('/api/queue/board')
      .set(DEVICE_TOKEN_HEADER, token)
      .expect(200);

    const payload = JSON.stringify(board.body);
    expect(payload).not.toContain(ALICE);
    expect(payload).not.toContain('4155550401');
    expect(payload).not.toContain('Anderson');
    expect(board.body.board.entries[0].displayName).toBe('Alice A.');
    // And no price, no notes, no service list.
    expect(board.body.board.entries[0].priceCentsTotal).toBeUndefined();
  });

  it('does not hand a kiosk the staff board as a side effect of joining', async () => {
    const token = await kioskToken();

    const response = await request(app)
      .post('/api/queue')
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ phone: ALICE, firstName: 'Alice', lastName: 'Anderson', serviceIds: [cutId] })
      .expect(201);

    expect(JSON.stringify(response.body)).not.toContain(ALICE);
    expect(response.body.board.entries[0].clientPhone).toBeUndefined();
  });

  it('keeps a kiosk out of every route that moves the line', async () => {
    const token = await kioskToken();
    const staff = await session(BARBER_EMAIL);

    const created = await request(app)
      .post('/api/queue')
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ phone: ALICE, firstName: 'Alice', serviceIds: [cutId] })
      .expect(201);

    for (const path of [
      `/api/queue/${created.body.entryId}/status`,
      `/api/queue/${created.body.entryId}/priority`,
      `/api/queue/${created.body.entryId}/barber`,
    ]) {
      await request(app).patch(path).set(DEVICE_TOKEN_HEADER, token).send({}).expect(401);
    }

    await request(app)
      .post('/api/queue/call-next')
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ barberId })
      .expect(401);

    // And the same route works for a signed-in barber, so the 401s above are the
    // guard talking rather than the route being broken.
    await request(app)
      .post('/api/queue/call-next')
      .set('Cookie', staff.cookies)
      .set(CSRF_HEADER, staff.csrfToken)
      .send({ barberId })
      .expect(200);
  });

  it('records who moved the line', async () => {
    const staff = await session(ADMIN_EMAIL);
    const token = await kioskToken();

    const created = await request(app)
      .post('/api/queue')
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ phone: ALICE, firstName: 'Alice', serviceIds: [cutId] })
      .expect(201);

    await request(app)
      .patch(`/api/queue/${created.body.entryId}/priority`)
      .set('Cookie', staff.cookies)
      .set(CSRF_HEADER, staff.csrfToken)
      .send({ priority: 5 })
      .expect(200);

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: created.body.entryId, action: 'queue.priority_changed' },
      include: { actor: true },
    });

    expect(audit?.actor?.email).toBe(ADMIN_EMAIL);
    expect(audit?.before).toEqual({ priority: 0 });
    expect(audit?.after).toEqual({ priority: 5 });

    // The join came from the kiosk, so that one is attributed to the device instead.
    const joined = await prisma.auditLog.findFirst({
      where: { entityId: created.body.entryId, action: 'queue.joined' },
    });
    expect(joined?.actorUserId).toBeNull();
    expect(joined?.actorDeviceId).not.toBeNull();
  });
});

// --- Helpers -----------------------------------------------------------------

function positionOf(board: Awaited<ReturnType<typeof getQueueBoard>>, entryId: string) {
  return board.entries.find((row) => row.entry.id === entryId)?.assignment?.position;
}

function readyAt(board: Awaited<ReturnType<typeof getQueueBoard>>, entryId: string) {
  return board.entries
    .find((row) => row.entry.id === entryId)
    ?.assignment?.estimatedReadyAt?.toISOString();
}
