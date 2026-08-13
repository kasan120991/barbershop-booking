/**
 * Booking — the double-booking guard above all.
 *
 * Database-backed on purpose: the whole point is the row lock, and an in-memory fake
 * would prove nothing. Fixtures namespaced to `@booking.test` with scoped cleanup.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../lib/prisma.js';
import {
  cancelAppointment,
  cancelAppointmentByToken,
  createAppointment,
  rescheduleAppointment,
  updateAppointmentStatus,
} from './booking.js';
import { getAvailability } from './availability.js';
import { hashPassword } from './passwords.js';

const PREFIX = 'BOOKTEST ';
const BARBER_EMAIL = 'barber@booking.test';
/** A second chair, for the cross-barber reschedule cases. */
const OTHER_BARBER_EMAIL = 'barber2@booking.test';
const EMAILS = [BARBER_EMAIL, OTHER_BARBER_EMAIL];
const CLIENT_PHONE = '+14155550301';
/** Distinct numbers so the concurrency test races the booking lock, not a client upsert. */
const RACER_ONE = '+14155550302';
const RACER_TWO = '+14155550303';

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

let barberId = '';
let otherBarberId = '';
let serviceId = '';
/** Offered by the first barber only, so a move to the second must be refused. */
let exclusiveServiceId = '';

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
  await prisma.barberService.deleteMany({ where: { service: { name: { startsWith: PREFIX } } } });
  await prisma.barber.deleteMany({ where: { user: { email: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.service.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.client.deleteMany({
    where: { phoneE164: { in: [CLIENT_PHONE, RACER_ONE, RACER_TWO] } },
  });
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
    create: {
      id: 1,
      name: 'Francis Cutz',
      timezone: 'America/New_York',
      bookingHorizonDays: 365,
    },
  });

  const user = await prisma.user.create({
    data: {
      email: BARBER_EMAIL,
      passwordHash: await hashPassword('FrancisCutz!2026'),
      firstName: 'Book',
      lastName: 'Tester',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  const barber = await prisma.barber.create({
    data: { userId: user.id, displayName: 'Booktester', slug: `booktester-${user.id}` },
  });
  barberId = barber.id;

  // Tuesdays, 10:00–18:00 local, no break — keeps the arithmetic obvious.
  await prisma.barberSchedule.create({
    data: { barberId, dayOfWeek: 2, startMinute: 600, endMinute: 1080 },
  });

  const otherUser = await prisma.user.create({
    data: {
      email: OTHER_BARBER_EMAIL,
      passwordHash: await hashPassword('FrancisCutz!2026'),
      firstName: 'Book',
      lastName: 'Tester Two',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  const otherBarber = await prisma.barber.create({
    data: { userId: otherUser.id, displayName: 'Booktwo', slug: `booktwo-${otherUser.id}` },
  });
  otherBarberId = otherBarber.id;
  await prisma.barberSchedule.create({
    data: { barberId: otherBarberId, dayOfWeek: 2, startMinute: 600, endMinute: 1080 },
  });

  const service = await prisma.service.create({
    data: { name: `${PREFIX}Haircut`, priceCents: 4500, durationMinutes: 45 },
  });
  serviceId = service.id;
  await prisma.barberService.create({ data: { barberId, serviceId } });
  await prisma.barberService.create({ data: { barberId: otherBarberId, serviceId } });

  const exclusive = await prisma.service.create({
    data: { name: `${PREFIX}Colour`, priceCents: 12000, durationMinutes: 90 },
  });
  exclusiveServiceId = exclusive.id;
  await prisma.barberService.create({ data: { barberId, serviceId: exclusiveServiceId } });
}

/** 2026-08-11 is a Tuesday; 10:00 local is 14:00Z in August. */
const SLOT = new Date('2026-08-11T14:00:00.000Z');
const NOW = new Date('2026-08-01T12:00:00.000Z');

function bookingInput(overrides: Record<string, unknown> = {}) {
  return {
    barberId,
    serviceIds: [serviceId],
    startAt: SLOT,
    client: { phone: CLIENT_PHONE, firstName: 'Race' },
    source: 'ONLINE' as const,
    enforceMinimumNotice: false,
    // These predate the online switches and are about other rules; the shop's online
    // flags have their own file.
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

describe.skipIf(!reachable)('creating an appointment', () => {
  beforeEach(reseed);

  it('snapshots price and duration from the service rows', async () => {
    const appointment = await createAppointment(bookingInput());

    expect(appointment.priceCentsTotal).toBe(4500);
    expect(appointment.durationMinutes).toBe(45);
    expect(appointment.endAt.toISOString()).toBe('2026-08-11T14:45:00.000Z');
    expect(appointment.services[0]?.priceCents).toBe(4500);
    expect(appointment.services[0]?.nameSnapshot).toBe(`${PREFIX}Haircut`);
  });

  it('ignores a price or duration supplied by the caller', async () => {
    // These fields are not part of the input type; the point is that even smuggled
    // through, nothing reads them.
    const appointment = await createAppointment(
      bookingInput({ priceCentsTotal: 1, durationMinutes: 5 }),
    );
    expect(appointment.priceCentsTotal).toBe(4500);
    expect(appointment.durationMinutes).toBe(45);
  });

  it('keeps the snapshot when the menu changes afterwards', async () => {
    const appointment = await createAppointment(bookingInput());
    await prisma.service.update({ where: { id: serviceId }, data: { priceCents: 9900 } });

    const reloaded = await prisma.appointment.findUnique({
      where: { id: appointment.id },
      include: { services: true },
    });

    // History is not rewritten by an edit to the live menu.
    expect(reloaded?.priceCentsTotal).toBe(4500);
    expect(reloaded?.services[0]?.priceCents).toBe(4500);
  });

  it('sums several services', async () => {
    const beard = await prisma.service.create({
      data: { name: `${PREFIX}Beard`, priceCents: 2000, durationMinutes: 20 },
    });

    const appointment = await createAppointment(
      bookingInput({ serviceIds: [serviceId, beard.id] }),
    );

    expect(appointment.priceCentsTotal).toBe(6500);
    expect(appointment.durationMinutes).toBe(65);
  });

  it('normalises the phone so one client is not created twice', async () => {
    await createAppointment(bookingInput());
    await createAppointment(
      bookingInput({
        startAt: new Date('2026-08-11T16:00:00.000Z'),
        client: { phone: '(415) 555-0301', firstName: 'Race' },
      }),
    );

    const clients = await prisma.client.findMany({ where: { phoneE164: CLIENT_PHONE } });
    expect(clients).toHaveLength(1);
  });

  it('refuses a time that has already passed', async () => {
    await expect(
      createAppointment(bookingInput({ now: new Date('2026-08-12T00:00:00.000Z') })),
    ).rejects.toThrow(/already passed/i);
  });

  it('enforces the notice window for the public but not for staff', async () => {
    // 30 minutes before the slot, against a 60-minute notice setting.
    const tooSoon = new Date(SLOT.getTime() - 30 * 60_000);

    await expect(
      createAppointment(bookingInput({ now: tooSoon, enforceMinimumNotice: true })),
    ).rejects.toThrow(/notice/i);

    const staffBooking = await createAppointment(
      bookingInput({ now: tooSoon, enforceMinimumNotice: false, source: 'STAFF' }),
    );
    expect(staffBooking.id).toBeTruthy();
  });
});

describe.skipIf(!reachable)('the double-booking guard', () => {
  beforeEach(reseed);

  it('refuses a second booking that overlaps the first', async () => {
    await createAppointment(bookingInput());

    // Starts 15 minutes in, so it overlaps the 45-minute first booking.
    await expect(
      createAppointment(bookingInput({ startAt: new Date('2026-08-11T14:15:00.000Z') })),
    ).rejects.toThrow(/just took that time/i);
  });

  it('allows a booking that starts exactly when the previous one ends', async () => {
    await createAppointment(bookingInput());
    const back2back = await createAppointment(
      bookingInput({ startAt: new Date('2026-08-11T14:45:00.000Z') }),
    );
    expect(back2back.id).toBeTruthy();
  });

  it('respects the buffer between appointments', async () => {
    await prisma.shopSettings.update({ where: { id: 1 }, data: { bufferMinutes: 15 } });
    await createAppointment(bookingInput());

    // 14:45 is now inside the turnaround.
    await expect(
      createAppointment(bookingInput({ startAt: new Date('2026-08-11T14:45:00.000Z') })),
    ).rejects.toThrow(/just took that time/i);

    const afterBuffer = await createAppointment(
      bookingInput({ startAt: new Date('2026-08-11T15:00:00.000Z') }),
    );
    expect(afterBuffer.id).toBeTruthy();
  });

  /**
   * The test the row lock exists for.
   *
   * Both requests check availability, both find the slot free, and both try to
   * insert. Without `SELECT ... FOR UPDATE` on the per-barber-per-day row, both
   * succeed and two people arrive for one chair. Run several times because a race
   * that only fails occasionally is still broken.
   */
  it('lets exactly one of two concurrent bookings win', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await reseed();

      // The lock row must ALREADY exist, which is the realistic case — any day with
      // a prior booking has one. When it does not, the `INSERT IGNORE` takes the key
      // lock itself and serialises the racers, so the test passes even with
      // `FOR UPDATE` removed. Both of these were verified by removing the lock and
      // watching this test go green; it only turns red with the row pre-created.
      await prisma.barberDayLock.create({ data: { barberId, day: '2026-08-11' } });

      // DIFFERENT phone numbers, deliberately. Two racers sharing one number both
      // upsert the same `clients` row, and that unique-key lock serialises them
      // before the booking transaction ever races.
      const results = await Promise.allSettled([
        createAppointment(bookingInput({ client: { phone: RACER_ONE, firstName: 'First' } })),
        createAppointment(bookingInput({ client: { phone: RACER_TWO, firstName: 'Second' } })),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // And the database agrees — one row, not two.
      const stored = await prisma.appointment.findMany({
        where: { barberId, status: { in: ['BOOKED', 'IN_PROGRESS'] } },
      });
      expect(stored).toHaveLength(1);
    }
  });

  it('frees the slot again once cancelled', async () => {
    const first = await createAppointment(bookingInput());
    await cancelAppointment(first.id, { enforceMinimumNotice: false, now: NOW });

    const rebooked = await createAppointment(bookingInput());
    expect(rebooked.id).toBeTruthy();
    expect(rebooked.id).not.toBe(first.id);
  });
});

describe.skipIf(!reachable)('availability and booking agree', () => {
  beforeEach(reseed);

  it('a booked slot disappears from availability', async () => {
    const before = await getAvailability({
      barberId,
      date: '2026-08-11',
      serviceIds: [serviceId],
      now: NOW,
    });
    expect(before.slots.map((slot) => slot.toISOString())).toContain(SLOT.toISOString());

    await createAppointment(bookingInput());

    const after = await getAvailability({
      barberId,
      date: '2026-08-11',
      serviceIds: [serviceId],
      now: NOW,
    });
    expect(after.slots.map((slot) => slot.toISOString())).not.toContain(SLOT.toISOString());
  });

  it('every slot availability offers can actually be booked', async () => {
    const result = await getAvailability({
      barberId,
      date: '2026-08-11',
      serviceIds: [serviceId],
      now: NOW,
    });

    // Take a handful spread across the day rather than all of them.
    for (const slot of [result.slots[0]!, result.slots[3]!, result.slots.at(-1)!]) {
      const appointment = await createAppointment(bookingInput({ startAt: slot }));
      expect(appointment.id).toBeTruthy();
      await prisma.appointment.delete({ where: { id: appointment.id } });
    }
  });
});

describe.skipIf(!reachable)('cancellation and status', () => {
  beforeEach(reseed);

  it('cancels by opaque token', async () => {
    const appointment = await createAppointment(bookingInput());
    const withToken = await prisma.appointment.findUnique({ where: { id: appointment.id } });

    const cancelled = await cancelAppointmentByToken(withToken!.cancelToken, {
      enforceMinimumNotice: false,
      now: NOW,
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledAt).not.toBeNull();
  });

  it('gives a plain not-found for a wrong token, revealing nothing', async () => {
    await expect(
      cancelAppointmentByToken('not-a-real-token', { enforceMinimumNotice: false }),
    ).rejects.toThrow(/not valid/i);
  });

  it('refuses a public cancellation inside the notice window but allows staff', async () => {
    const appointment = await createAppointment(bookingInput());
    const tooLate = new Date(SLOT.getTime() - 10 * 60_000);

    await expect(
      cancelAppointment(appointment.id, { enforceMinimumNotice: true, now: tooLate }),
    ).rejects.toThrow(/too close/i);

    const staffCancelled = await cancelAppointment(appointment.id, {
      enforceMinimumNotice: false,
      now: tooLate,
    });
    expect(staffCancelled.status).toBe('CANCELLED');
  });

  it('walks the status transitions and refuses the nonsensical ones', async () => {
    const appointment = await createAppointment(bookingInput());

    const started = await updateAppointmentStatus(appointment.id, 'IN_PROGRESS');
    expect(started.status).toBe('IN_PROGRESS');

    const done = await updateAppointmentStatus(appointment.id, 'COMPLETED');
    expect(done.status).toBe('COMPLETED');

    // A finished cut cannot be un-finished.
    await expect(updateAppointmentStatus(appointment.id, 'BOOKED')).rejects.toThrow(/cannot become/i);
    await expect(updateAppointmentStatus(appointment.id, 'CANCELLED')).rejects.toThrow(
      /cannot become/i,
    );
  });

  it('refuses to cancel something already cancelled', async () => {
    const appointment = await createAppointment(bookingInput());
    await cancelAppointment(appointment.id, { enforceMinimumNotice: false, now: NOW });

    await expect(
      cancelAppointment(appointment.id, { enforceMinimumNotice: false, now: NOW }),
    ).rejects.toThrow(/already cancelled/i);
  });
});

describe.skipIf(!reachable)('rescheduling an appointment', () => {
  beforeEach(reseed);

  /** 11:00 local on the same Tuesday, an hour after SLOT. */
  const LATER = new Date('2026-08-11T15:00:00.000Z');

  function rescheduleInput(appointmentId: string, overrides: Record<string, unknown> = {}) {
    return {
      appointmentId,
      startAt: LATER,
      enforceMinimumNotice: false,
      enforceOnlineRules: false,
      now: NOW,
      ...overrides,
    };
  }

  it('moves the time while keeping the id and the cancel token', async () => {
    const booked = await createAppointment(bookingInput());

    const moved = await rescheduleAppointment(rescheduleInput(booked.id));

    expect(moved.id).toBe(booked.id);
    // The link the client already holds has to keep working. Reissuing it is the whole
    // reason this is an update rather than a cancel and a create.
    expect(moved.cancelToken).toBe(booked.cancelToken);
    expect(moved.startAt.toISOString()).toBe(LATER.toISOString());
    expect(moved.endAt.toISOString()).toBe(new Date(LATER.getTime() + 45 * 60_000).toISOString());
    expect(moved.status).toBe('BOOKED');
  });

  it('does not reprice a move when the menu has changed underneath it', async () => {
    const booked = await createAppointment(bookingInput());
    expect(booked.priceCentsTotal).toBe(4500);

    // The shop puts its prices up between the booking and the phone call.
    await prisma.service.update({
      where: { id: serviceId },
      data: { priceCents: 6000, durationMinutes: 60 },
    });

    const moved = await rescheduleAppointment(rescheduleInput(booked.id));

    // Snapshots are what the client agreed to. A move is not a repricing.
    expect(moved.priceCentsTotal).toBe(4500);
    expect(moved.durationMinutes).toBe(45);
    expect(moved.services[0]?.priceCents).toBe(4500);
    expect(moved.endAt.toISOString()).toBe(new Date(LATER.getTime() + 45 * 60_000).toISOString());
  });

  it('re-snapshots when the basket genuinely changes', async () => {
    const booked = await createAppointment(bookingInput());

    const moved = await rescheduleAppointment(
      rescheduleInput(booked.id, { serviceIds: [exclusiveServiceId] }),
    );

    expect(moved.priceCentsTotal).toBe(12000);
    expect(moved.durationMinutes).toBe(90);
    expect(moved.services).toHaveLength(1);
    expect(moved.services[0]?.serviceId).toBe(exclusiveServiceId);
  });

  it('treats the same basket in a different order as no change at all', async () => {
    const booked = await createAppointment(bookingInput());
    await prisma.service.update({ where: { id: serviceId }, data: { priceCents: 9900 } });

    // Re-sending what is already booked must not trigger a re-snapshot at the new price.
    const moved = await rescheduleAppointment(
      rescheduleInput(booked.id, { serviceIds: [serviceId] }),
    );

    expect(moved.priceCentsTotal).toBe(4500);
  });

  /**
   * The highest-value case in this file.
   *
   * Nudging a 45-minute cut by fifteen minutes overlaps its own old footprint. Without
   * `excludeAppointmentId` the appointment finds itself in the conflict query and the
   * move is refused — a failure that reads exactly like somebody else taking the slot.
   */
  it('allows a move that overlaps only itself', async () => {
    const booked = await createAppointment(bookingInput());
    const nudged = new Date(SLOT.getTime() + 15 * 60_000);

    const moved = await rescheduleAppointment(rescheduleInput(booked.id, { startAt: nudged }));

    expect(moved.startAt.toISOString()).toBe(nudged.toISOString());
  });

  it('refuses a move onto somebody else in the same chair', async () => {
    const first = await createAppointment(bookingInput());
    await createAppointment(
      bookingInput({ startAt: LATER, client: { phone: RACER_ONE, firstName: 'Other' } }),
    );

    await expect(rescheduleAppointment(rescheduleInput(first.id))).rejects.toThrow(
      /just took that time/i,
    );
  });

  it('honours the turnaround buffer on both sides of the new time', async () => {
    await prisma.shopSettings.update({ where: { id: 1 }, data: { bufferMinutes: 15 } });

    const first = await createAppointment(bookingInput());
    // 12:00 local — an hour clear of the 10:00–10:45 booking above.
    const noon = new Date('2026-08-11T16:00:00.000Z');
    const second = await createAppointment(
      bookingInput({ startAt: noon, client: { phone: RACER_ONE, firstName: 'Other' } }),
    );

    // Ends at 12:45; moving the first to start at 12:50 leaves only five minutes.
    const tooClose = new Date(noon.getTime() + 50 * 60_000);
    await expect(
      rescheduleAppointment(rescheduleInput(first.id, { startAt: tooClose })),
    ).rejects.toThrow(/just took that time/i);

    expect(second.id).toBeTruthy();
  });

  it('frees the old chair and fills the new one when it moves across barbers', async () => {
    const booked = await createAppointment(bookingInput());

    const moved = await rescheduleAppointment(
      rescheduleInput(booked.id, { barberId: otherBarberId, startAt: SLOT }),
    );
    expect(moved.barberId).toBe(otherBarberId);

    const date = '2026-08-11';
    const freed = await getAvailability({ barberId, date, serviceIds: [serviceId], now: NOW });
    const taken = await getAvailability({
      barberId: otherBarberId,
      date,
      serviceIds: [serviceId],
      now: NOW,
    });

    const iso = SLOT.toISOString();
    expect(freed.slots.map((slot) => slot.toISOString())).toContain(iso);
    expect(taken.slots.map((slot) => slot.toISOString())).not.toContain(iso);
  });

  it('refuses a chair that does not do the booked service', async () => {
    const booked = await createAppointment(
      bookingInput({ serviceIds: [exclusiveServiceId], startAt: SLOT }),
    );

    // The second barber never had that service. The booking clients filter the roster
    // before offering a chair; a voice caller has no such list in front of them.
    await expect(
      rescheduleAppointment(rescheduleInput(booked.id, { barberId: otherBarberId })),
    ).rejects.toThrow(/does not do all of those services/i);
  });

  it('locks both days when it moves across barbers, and one when it does not', async () => {
    const booked = await createAppointment(bookingInput());
    await prisma.barberDayLock.deleteMany({
      where: { barber: { user: { email: { in: EMAILS } } } },
    });

    await rescheduleAppointment(rescheduleInput(booked.id, { startAt: LATER }));
    // Same barber, same local day — deduped to a single lock row.
    expect(
      await prisma.barberDayLock.count({
        where: { barber: { user: { email: { in: EMAILS } } } },
      }),
    ).toBe(1);

    await rescheduleAppointment(
      rescheduleInput(booked.id, { barberId: otherBarberId, startAt: SLOT }),
    );
    expect(
      await prisma.barberDayLock.count({
        where: { barber: { user: { email: { in: EMAILS } } } },
      }),
    ).toBe(2);
  });

  it('lets exactly one of two concurrent moves into the same slot win', async () => {
    const first = await createAppointment(bookingInput());
    const second = await createAppointment(
      bookingInput({
        startAt: new Date('2026-08-11T16:00:00.000Z'),
        client: { phone: RACER_ONE, firstName: 'Other' },
      }),
    );

    const results = await Promise.allSettled([
      rescheduleAppointment(rescheduleInput(first.id, { startAt: LATER })),
      rescheduleAppointment(rescheduleInput(second.id, { startAt: LATER })),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('races a create and a move through the same exclusion', async () => {
    const existing = await createAppointment(bookingInput());

    const results = await Promise.allSettled([
      rescheduleAppointment(rescheduleInput(existing.id, { startAt: LATER })),
      createAppointment(
        bookingInput({ startAt: LATER, client: { phone: RACER_TWO, firstName: 'Walkup' } }),
      ),
    ]);

    // One exclusion, two entry points. If reschedule had grown its own copy of the
    // overlap check, both of these would succeed and one chair would hold two people.
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('does not deadlock when two moves cross in opposite directions', async () => {
    const mine = await createAppointment(bookingInput());
    const theirs = await createAppointment({
      ...bookingInput({ client: { phone: RACER_ONE, firstName: 'Other' } }),
      barberId: otherBarberId,
      startAt: LATER,
    });

    // A -> B's day while B -> A's day. Unordered locking makes each hold what the other
    // waits for, and InnoDB kills one with "write conflict or deadlock".
    const results = await Promise.allSettled([
      rescheduleAppointment(
        rescheduleInput(mine.id, { barberId: otherBarberId, startAt: new Date('2026-08-11T17:00:00.000Z') }),
      ),
      rescheduleAppointment(
        rescheduleInput(theirs.id, { barberId, startAt: new Date('2026-08-11T18:00:00.000Z') }),
      ),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        expect(String(result.reason)).not.toMatch(/deadlock|write conflict/i);
      }
    }
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
  });

  it('refuses to move anything that is not still booked', async () => {
    const started = await createAppointment(bookingInput());
    await updateAppointmentStatus(started.id, 'IN_PROGRESS');
    await expect(rescheduleAppointment(rescheduleInput(started.id))).rejects.toThrow(
      /already started/i,
    );

    const done = await createAppointment(
      bookingInput({
        startAt: new Date('2026-08-11T16:00:00.000Z'),
        client: { phone: RACER_ONE, firstName: 'Other' },
      }),
    );
    await updateAppointmentStatus(done.id, 'COMPLETED');
    await expect(rescheduleAppointment(rescheduleInput(done.id))).rejects.toThrow(
      /already happened/i,
    );

    const gone = await createAppointment(
      bookingInput({
        startAt: new Date('2026-08-11T17:00:00.000Z'),
        client: { phone: RACER_TWO, firstName: 'Third' },
      }),
    );
    await cancelAppointment(gone.id, { enforceMinimumNotice: false, now: NOW });
    await expect(rescheduleAppointment(rescheduleInput(gone.id))).rejects.toThrow(/was cancelled/i);
  });

  it('refuses a new time in the past', async () => {
    const booked = await createAppointment(bookingInput());

    await expect(
      rescheduleAppointment(
        rescheduleInput(booked.id, { startAt: new Date('2026-07-01T14:00:00.000Z') }),
      ),
    ).rejects.toThrow(/already passed/i);
  });

  /**
   * Both halves, per the standing rule for these flags: the public is held to the notice
   * window and staff are not. A test that asserted only one half would let the other
   * silently invert.
   */
  it('holds the public to the notice window and lets staff move anything', async () => {
    const booked = await createAppointment(bookingInput());

    // Half an hour before a 10:00 booking, with the window at 60 minutes.
    const justBefore = new Date('2026-08-11T13:30:00.000Z');

    await expect(
      rescheduleAppointment(
        rescheduleInput(booked.id, {
          startAt: LATER,
          enforceMinimumNotice: true,
          now: justBefore,
        }),
      ),
    ).rejects.toThrow(/too close to your appointment/i);

    const moved = await rescheduleAppointment(
      rescheduleInput(booked.id, { startAt: LATER, enforceMinimumNotice: false, now: justBefore }),
    );
    expect(moved.startAt.toISOString()).toBe(LATER.toISOString());
  });

  it('refuses a new time inside the notice window for the public', async () => {
    const booked = await createAppointment(bookingInput());

    // The old start is comfortably clear; the NEW one is thirty minutes away.
    const now = new Date('2026-08-11T13:00:00.000Z');
    await expect(
      rescheduleAppointment(
        rescheduleInput(booked.id, {
          startAt: new Date('2026-08-11T13:30:00.000Z'),
          enforceMinimumNotice: true,
          now,
        }),
      ),
    ).rejects.toThrow(/of notice/i);
  });
});
