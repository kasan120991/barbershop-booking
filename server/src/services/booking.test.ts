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
  updateAppointmentStatus,
} from './booking.js';
import { getAvailability } from './availability.js';
import { hashPassword } from './passwords.js';

const PREFIX = 'BOOKTEST ';
const BARBER_EMAIL = 'barber@booking.test';
const CLIENT_PHONE = '+14155550301';
/** Distinct numbers so the concurrency test races the booking lock, not a client upsert. */
const RACER_ONE = '+14155550302';
const RACER_TWO = '+14155550303';

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

let barberId = '';
let serviceId = '';

async function cleanup() {
  await prisma.appointmentService.deleteMany({
    where: { appointment: { barber: { user: { email: BARBER_EMAIL } } } },
  });
  await prisma.appointment.deleteMany({ where: { barber: { user: { email: BARBER_EMAIL } } } });
  await prisma.barberDayLock.deleteMany({ where: { barber: { user: { email: BARBER_EMAIL } } } });
  await prisma.barberSchedule.deleteMany({ where: { barber: { user: { email: BARBER_EMAIL } } } });
  await prisma.barberService.deleteMany({ where: { service: { name: { startsWith: PREFIX } } } });
  await prisma.barber.deleteMany({ where: { user: { email: BARBER_EMAIL } } });
  await prisma.user.deleteMany({ where: { email: BARBER_EMAIL } });
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

  const service = await prisma.service.create({
    data: { name: `${PREFIX}Haircut`, priceCents: 4500, durationMinutes: 45 },
  });
  serviceId = service.id;
  await prisma.barberService.create({ data: { barberId, serviceId } });
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
