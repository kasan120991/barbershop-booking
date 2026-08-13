/**
 * The phone receptionist's logic.
 *
 * Database-backed, because the questions worth asking are about who a caller is and what
 * they are allowed to reach — neither of which an in-memory fake would prove. Fixtures
 * namespaced to `@voice.test`.
 *
 * The privacy assertions here are the ones to keep: a caller must not be able to walk
 * these tools to find out whether a number is a customer or what somebody else has booked.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../lib/prisma.js';
import { createAppointment } from './booking.js';
import {
  __testing,
  bookAppointmentByVoice,
  cancelByVoice,
  composeGreeting,
  findAppointmentTimesForVoice,
  findMyAppointmentsForVoice,
  getWalkInWaitForVoice,
  listServicesForVoice,
  rescheduleByVoice,
  type VoiceCallContext,
} from './voice.js';
import { hashPassword } from './passwords.js';

const PREFIX = 'VOICETEST ';
const BARBER_EMAIL = 'barber@voice.test';
const CALLER = '+14155550501';
const STRANGER = '+14155550502';

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

let barberId = '';
let haircutId = '';

/** Tuesday 11 August 2026; 10:00 local is 14:00Z in August. */
const TUESDAY = '2026-08-11';
const TEN_AM = new Date('2026-08-11T14:00:00.000Z');
/** A week earlier, so nothing sits inside the notice window. */
const NOW = new Date('2026-08-04T12:00:00.000Z');

function context(overrides: Partial<VoiceCallContext> = {}): VoiceCallContext {
  return {
    callId: 'call_voice_test',
    callerPhoneE164: CALLER,
    timezone: 'America/New_York',
    now: NOW,
    ...overrides,
  };
}

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
  await prisma.client.deleteMany({ where: { phoneE164: { in: [CALLER, STRANGER] } } });
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
      voiceBookingEnabled: true,
      onlineBookingEnabled: true,
      walkInQueueEnabled: true,
    },
    create: { id: 1, name: 'Francis Cutz', timezone: 'America/New_York', bookingHorizonDays: 365 },
  });

  const user = await prisma.user.create({
    data: {
      email: BARBER_EMAIL,
      passwordHash: await hashPassword('FrancisCutz!2026'),
      firstName: 'Voice',
      lastName: 'Tester',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  const barber = await prisma.barber.create({
    data: { userId: user.id, displayName: 'Voicetester', slug: `voicetester-${user.id}` },
  });
  barberId = barber.id;

  await prisma.barberSchedule.create({
    data: { barberId, dayOfWeek: 2, startMinute: 600, endMinute: 1000 },
  });

  const haircut = await prisma.service.create({
    data: { name: `${PREFIX}Haircut`, priceCents: 4500, durationMinutes: 45 },
  });
  haircutId = haircut.id;
  await prisma.barberService.create({ data: { barberId, serviceId: haircutId } });
}

/** Books a cut for the given number, straight through the real booking path. */
async function book(phone = CALLER, startAt = TEN_AM) {
  return createAppointment({
    barberId,
    serviceIds: [haircutId],
    startAt,
    client: { phone, firstName: phone === CALLER ? 'Marcus' : 'Stranger' },
    source: 'VOICE',
    enforceMinimumNotice: false,
    enforceOnlineRules: false,
    now: NOW,
  });
}

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

describe('offer refs', () => {
  it('round-trips a slot without ever exposing a readable time', () => {
    const ref = __testing.encodeOfferRef({
      barberId: 'brb_123',
      startAt: TEN_AM,
      serviceIds: ['svc_a', 'svc_b'],
    });

    // base64url only, so nothing in it survives being read aloud by accident.
    expect(ref).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = __testing.decodeOfferRef(ref);
    expect(decoded.barberId).toBe('brb_123');
    expect(decoded.startAt.toISOString()).toBe(TEN_AM.toISOString());
    expect(decoded.serviceIds).toEqual(['svc_a', 'svc_b']);
  });

  it('turns a mangled ref into something the assistant can say, not a crash', () => {
    // The model dropping a character is the realistic failure, and it must not 500.
    for (const bad of ['', 'not-a-ref', 'eyJiIjoi', Buffer.from('{}').toString('base64url')]) {
      expect(() => __testing.decodeOfferRef(bad)).toThrow(/check those times again/i);
    }
  });
});

describe('resolving what a caller said', () => {
  it('reads a weekday as the NEXT one, never the one that just passed', () => {
    const tz = 'America/New_York';
    // NOW is Tuesday 4 August. "Tuesday" means the 11th, not five minutes ago.
    expect(__testing.resolveSpokenDay('tuesday', tz, NOW)).toBe(TUESDAY);
    expect(__testing.resolveSpokenDay('today', tz, NOW)).toBe('2026-08-04');
    expect(__testing.resolveSpokenDay('tomorrow', tz, NOW)).toBe('2026-08-05');
    expect(__testing.resolveSpokenDay('2026-08-20', tz, NOW)).toBe('2026-08-20');
  });

  it('refuses a day it cannot understand rather than guessing one', () => {
    expect(() => __testing.resolveSpokenDay('whenever', 'America/New_York', NOW)).toThrow(
      /what day/i,
    );
  });

  it('reads a bare small hour as the afternoon, because nobody books 4am', () => {
    expect(__testing.parseSpokenHour('after 4')).toBe(16);
    expect(__testing.parseSpokenHour('4pm')).toBe(16);
    expect(__testing.parseSpokenHour('16:00')).toBe(16);
    expect(__testing.parseSpokenHour('9am')).toBe(9);
    // 9 is a plausible morning appointment, so a bare 9 stays 9.
    expect(__testing.parseSpokenHour('9')).toBe(9);
  });
});

describe.skipIf(!reachable)('the greeting', () => {
  beforeEach(reseed);

  it('greets a known caller by first name and names what they have booked', async () => {
    await book();

    const greeting = await composeGreeting(CALLER, NOW);

    expect(greeting.known).toBe(true);
    expect(greeting.firstName).toBe('Marcus');
    expect(greeting.firstMessage).toContain('Hi Marcus');
    expect(greeting.firstMessage).toMatch(/reschedule|cancel/i);
    expect(greeting.appointmentSummary).toContain('Voicetester');
  });

  it('never volunteers a surname, a number, or anything raw', async () => {
    await prisma.client.create({
      data: { phoneE164: CALLER, firstName: 'Marcus', lastName: 'Ferreira' },
    });
    await book();

    const greeting = await composeGreeting(CALLER, NOW);

    // First name only. The surname is on the record and stays there.
    expect(greeting.firstMessage).not.toContain('Ferreira');
    expect(greeting.firstMessage).not.toContain('4155550501');
    expect(greeting.firstMessage).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('greets an unknown number as a stranger', async () => {
    const greeting = await composeGreeting('+14155559999', NOW);

    expect(greeting.known).toBe(false);
    expect(greeting.firstName).toBeNull();
    expect(greeting.firstMessage).not.toMatch(/Hi \w/);
  });

  it('greets a withheld number as a stranger rather than failing', async () => {
    const greeting = await composeGreeting(null, NOW);
    expect(greeting.known).toBe(false);
  });

  it('greets a blocked client as a stranger', async () => {
    await prisma.client.create({
      data: { phoneE164: CALLER, firstName: 'Marcus', isBlocked: true },
    });

    // Greeting somebody by name and then refusing them a booking is worse than not
    // recognising them — the same reasoning `recogniseClient` uses.
    const greeting = await composeGreeting(CALLER, NOW);
    expect(greeting.known).toBe(false);
  });
});

describe.skipIf(!reachable)('finding and booking', () => {
  beforeEach(reseed);

  it('offers numbered times that name a barber and hide the machinery', async () => {
    const result = await findAppointmentTimesForVoice(context(), {
      services: ['Haircut'],
      day: 'tuesday',
    });

    expect(result.options?.length).toBeGreaterThan(0);
    expect(result.say).toContain('Voicetester');
    // Nothing a model could read aloud by mistake.
    expect(result.say).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(result.say).not.toContain(barberId);
    expect(result.options?.[0]?.option).toBe(1);
  });

  it('matches a service by a unique fragment of its name', async () => {
    const result = await findAppointmentTimesForVoice(context(), {
      services: ['haircut'],
      day: 'tuesday',
    });
    expect(result.options?.length).toBeGreaterThan(0);
  });

  it('asks rather than guesses when a name matches more than one service', async () => {
    await prisma.service.create({
      data: { name: `${PREFIX}Haircut Deluxe`, priceCents: 8000, durationMinutes: 60 },
    });

    await expect(
      findAppointmentTimesForVoice(context(), { services: ['haircut'], day: 'tuesday' }),
    ).rejects.toThrow(/did you mean/i);
  });

  it('books against an offered ref and reads the whole booking back', async () => {
    const offered = await findAppointmentTimesForVoice(context(), {
      services: ['Haircut'],
      day: 'tuesday',
    });
    const ref = offered.options?.[0]?.ref ?? '';

    const booked = await bookAppointmentByVoice(context(), {
      option_ref: ref,
      first_name: 'Marcus',
    });

    expect(booked.say).toContain('Marcus');
    expect(booked.say).toContain('Voicetester');
    expect(booked.say).toContain('$45');
    expect(booked.say).toMatch(/pay after/i);
    expect(booked.booking?.ref).toBeTruthy();

    const stored = await prisma.appointment.findUnique({
      where: { id: booked.booking?.ref ?? '' },
      include: { client: true },
    });
    expect(stored?.source).toBe('VOICE');
    expect(stored?.client.phoneE164).toBe(CALLER);
  });

  it('ignores a spoken number whenever caller ID gave one', async () => {
    const offered = await findAppointmentTimesForVoice(context(), {
      services: ['Haircut'],
      day: 'tuesday',
    });

    const booked = await bookAppointmentByVoice(context(), {
      option_ref: offered.options?.[0]?.ref ?? '',
      first_name: 'Marcus',
      // The model cannot be talked into booking against somebody else's number.
      phone: STRANGER,
    });

    const stored = await prisma.appointment.findUnique({
      where: { id: booked.booking?.ref ?? '' },
      include: { client: true },
    });
    expect(stored?.client.phoneE164).toBe(CALLER);
  });

  it('falls back to a spoken number only when the line withheld its own', async () => {
    const offered = await findAppointmentTimesForVoice(context(), {
      services: ['Haircut'],
      day: 'tuesday',
    });

    const booked = await bookAppointmentByVoice(context({ callerPhoneE164: null }), {
      option_ref: offered.options?.[0]?.ref ?? '',
      first_name: 'Withheld',
      phone: '(415) 555-0502',
    });

    const stored = await prisma.appointment.findUnique({
      where: { id: booked.booking?.ref ?? '' },
      include: { client: true },
    });
    expect(stored?.client.phoneE164).toBe(STRANGER);
  });

  it('returns the same confirmation when the model asks twice', async () => {
    const offered = await findAppointmentTimesForVoice(context(), {
      services: ['Haircut'],
      day: 'tuesday',
    });
    const ref = offered.options?.[0]?.ref ?? '';

    const first = await bookAppointmentByVoice(context(), { option_ref: ref, first_name: 'Marcus' });
    const second = await bookAppointmentByVoice(context(), { option_ref: ref, first_name: 'Marcus' });

    // The failure this prevents: the second attempt hits the day lock and the assistant
    // tells the caller their booking failed at the moment it actually succeeded.
    expect(second.say).toMatch(/already down/i);
    expect(second.booking?.ref).toBe(first.booking?.ref);
    expect(await prisma.appointment.count({ where: { barberId } })).toBe(1);
  });

  it('refuses to book when the phone line is switched off', async () => {
    const offered = await findAppointmentTimesForVoice(context(), {
      services: ['Haircut'],
      day: 'tuesday',
    });

    await prisma.shopSettings.update({ where: { id: 1 }, data: { voiceBookingEnabled: false } });

    await expect(
      bookAppointmentByVoice(context(), {
        option_ref: offered.options?.[0]?.ref ?? '',
        first_name: 'Marcus',
      }),
    ).rejects.toThrow(/can't book over the phone/i);
  });

  /**
   * Both halves, per the standing rule. The *online* switches govern the internet; the
   * phone has its own. A test asserting one half lets the other silently invert.
   */
  it('books by phone even when online booking is off and the service is phone-only', async () => {
    await prisma.shopSettings.update({ where: { id: 1 }, data: { onlineBookingEnabled: false } });
    await prisma.service.update({ where: { id: haircutId }, data: { bookableOnline: false } });

    const offered = await findAppointmentTimesForVoice(context(), {
      services: ['Haircut'],
      day: 'tuesday',
    });
    expect(offered.options?.length).toBeGreaterThan(0);

    const booked = await bookAppointmentByVoice(context(), {
      option_ref: offered.options?.[0]?.ref ?? '',
      first_name: 'Marcus',
    });

    // "has to be booked by phone" — and they are on the phone.
    expect(booked.booking?.ref).toBeTruthy();
  });
});

describe.skipIf(!reachable)('a caller’s own bookings', () => {
  beforeEach(reseed);

  it('lists what the calling number has coming up', async () => {
    await book();

    const result = await findMyAppointmentsForVoice(context());

    expect(result.options).toHaveLength(1);
    expect(result.say).toContain('Voicetester');
  });

  it('gives the same answer for an unknown number as for a wrong one', async () => {
    await book(STRANGER);

    const unknown = await findMyAppointmentsForVoice(
      context({ callerPhoneE164: '+14155559999' }),
    );

    // A caller must not be able to learn that a number IS a customer by the difference
    // between two refusals.
    expect(unknown.say).toBe("I can't find a booking under that number.");
  });

  it('tells a withheld number what it can and cannot do', async () => {
    const result = await findMyAppointmentsForVoice(context({ callerPhoneE164: null }));
    expect(result.say).toMatch(/only look that up for the number you booked on/i);
    expect(result.say).toMatch(/new booking/i);
  });

  it('refuses to touch somebody else’s appointment, with an identical sentence', async () => {
    const theirs = await book(STRANGER);

    await expect(cancelByVoice(context(), { appointment_ref: theirs.id })).rejects.toThrow(
      "I can't find a booking under that number.",
    );
    await expect(
      rescheduleByVoice(context(), { appointment_ref: theirs.id, option_ref: 'anything' }),
    ).rejects.toThrow("I can't find a booking under that number.");

    // A ref that does not exist at all gives the same answer, so the two cannot be told
    // apart by a caller probing for one.
    await expect(
      cancelByVoice(context(), { appointment_ref: 'nope' }),
    ).rejects.toThrow("I can't find a booking under that number.");
  });

  it('cancels the caller’s own booking and reads back which one', async () => {
    const mine = await book();

    const result = await cancelByVoice(context(), { appointment_ref: mine.id });

    expect(result.say).toMatch(/cancelled/i);
    expect(result.say).toContain('Voicetester');

    const stored = await prisma.appointment.findUnique({ where: { id: mine.id } });
    expect(stored?.status).toBe('CANCELLED');
  });

  it('moves a booking without repricing it', async () => {
    const mine = await book();

    // The menu goes up between booking and the phone call.
    await prisma.service.update({ where: { id: haircutId }, data: { priceCents: 9900 } });

    const offered = await findAppointmentTimesForVoice(context(), {
      for_appointment_ref: mine.id,
      day: 'tuesday',
      after_time: '2pm',
    });
    const ref = offered.options?.[0]?.ref ?? '';

    const moved = await rescheduleByVoice(context(), {
      appointment_ref: mine.id,
      option_ref: ref,
    });

    expect(moved.say).toMatch(/moved/i);
    expect(moved.say).toContain('$45');

    const stored = await prisma.appointment.findUnique({ where: { id: mine.id } });
    expect(stored?.priceCentsTotal).toBe(4500);
    // Same row, so the cancel link the client already holds still works.
    expect(stored?.cancelToken).toBe(mine.cancelToken);
  });

  it('reuses the booked services when looking for a new time', async () => {
    const mine = await book();

    const offered = await findAppointmentTimesForVoice(context(), {
      for_appointment_ref: mine.id,
      day: 'tuesday',
    });

    // Resolved from the booking, so a reschedule never asks "what were you having again?"
    const decoded = __testing.decodeOfferRef(offered.options?.[0]?.ref ?? '');
    expect(decoded.serviceIds).toEqual([haircutId]);
  });
});

describe.skipIf(!reachable)('reading the shop out loud', () => {
  beforeEach(reseed);

  it('lists the menu with prices a person would say', async () => {
    const result = await listServicesForVoice(context(), {});

    expect(result.say).toContain(`${PREFIX}Haircut`);
    expect(result.say).toContain('$45');
    expect(result.say).toContain('45 mins');
    // Never "$45.00", which text-to-speech reads as "and zero cents".
    expect(result.say).not.toContain('$45.00');
  });

  /**
   * Also found by ringing it: "how busy are you?" names no service, and quoting an empty
   * basket threw "Choose at least one service" at somebody who had not been asked to
   * choose anything.
   */
  it('quotes the headline wait when the caller named no service', async () => {
    const result = await getWalkInWaitForVoice(context(), {});

    expect(result.say).not.toMatch(/choose at least one/i);
    expect(result.say).toMatch(/wait|walk-in|book you a time/i);
  });

  it('says so plainly when walk-ins are switched off', async () => {
    await prisma.shopSettings.update({ where: { id: 1 }, data: { walkInQueueEnabled: false } });

    const result = await getWalkInWaitForVoice(context(), {});
    expect(result.say).toMatch(/not taking walk-ins/i);
    expect(result.say).toMatch(/book you a time/i);
  });
});
