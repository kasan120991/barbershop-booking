/**
 * The Vapi webhook: the envelope, the dispatch, and the two things that must never fail
 * the way HTTP normally would.
 *
 * The two properties worth defending here are (1) it answers 200 whenever it answered at
 * all, because a non-2xx is silence on somebody's phone, and (2) an exposed refusal is
 * SPOKEN while an unexpected fault is not. Fixtures namespaced to `@voicewebhook.test`.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_HEADER, DEVICE_TOKEN_HEADER } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../services/passwords.js';
import { VOICE_WEBHOOK_PATH } from './voice.js';

const app = createApp();

/** One listening server for the whole file — see the note in `devices.test.ts`. */
const server = app.listen(0);
afterAll(() => {
  server.close();
});

const PREFIX = 'VOICEHOOK ';
const ADMIN_EMAIL = 'admin@voicewebhook.test';
const BARBER_EMAIL = 'barber@voicewebhook.test';
const EMAILS = [ADMIN_EMAIL, BARBER_EMAIL];
const PASSWORD = 'FrancisCutz!2026';
const CALLER = '+14155550601';

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

let voiceToken = '';
let kioskToken = '';
let haircutId = '';
let barberId = '';

async function cleanup() {
  await prisma.voiceToolCall.deleteMany({ where: { callId: { startsWith: 'call_hook' } } });
  await prisma.appointmentService.deleteMany({
    where: { appointment: { barber: { user: { email: BARBER_EMAIL } } } },
  });
  await prisma.appointment.deleteMany({ where: { barber: { user: { email: BARBER_EMAIL } } } });
  await prisma.barberDayLock.deleteMany({ where: { barber: { user: { email: BARBER_EMAIL } } } });
  await prisma.barberSchedule.deleteMany({ where: { barber: { user: { email: BARBER_EMAIL } } } });
  await prisma.barberService.deleteMany({ where: { service: { name: { startsWith: PREFIX } } } });
  await prisma.barber.deleteMany({ where: { user: { email: BARBER_EMAIL } } });
  await prisma.device.deleteMany({ where: { label: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.service.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.client.deleteMany({ where: { phoneE164: CALLER } });
}

async function reseed() {
  await cleanup();

  await prisma.shopSettings.upsert({
    where: { id: 1 },
    update: {
      timezone: 'America/New_York',
      voiceBookingEnabled: true,
      walkInQueueEnabled: true,
      bookingHorizonDays: 365,
    },
    create: { id: 1, name: 'Francis Cutz', timezone: 'America/New_York', bookingHorizonDays: 365 },
  });

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Hook',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });

  const barberUser = await prisma.user.create({
    data: {
      email: BARBER_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Hook',
      lastName: 'Barber',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  const barber = await prisma.barber.create({
    data: { userId: barberUser.id, displayName: 'Hookbarber', slug: `hookbarber-${barberUser.id}` },
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

  const login = await request(server)
    .post('/api/auth/login')
    .send({ email: ADMIN_EMAIL, password: PASSWORD })
    .expect(200);

  const cookies = login.headers['set-cookie'] as unknown as string[];
  const csrf = login.body.csrfToken as string;

  const line = await request(server)
    .post('/api/devices')
    .set('Cookie', cookies)
    .set(CSRF_HEADER, csrf)
    .send({ label: `${PREFIX}Phone line`, type: 'VOICE' })
    .expect(201);
  voiceToken = line.body.deviceToken as string;

  const kiosk = await request(server)
    .post('/api/devices')
    .set('Cookie', cookies)
    .set(CSRF_HEADER, csrf)
    .send({ label: `${PREFIX}Door tablet`, type: 'KIOSK' })
    .expect(201);
  const paired = await request(server)
    .post('/api/devices/pair')
    .send({ pairingCode: kiosk.body.pairingCode })
    .expect(200);
  kioskToken = paired.body.deviceToken as string;
}

/** A tool-calls envelope shaped the way Vapi sends one. */
function envelope(
  calls: unknown[],
  overrides: { callId?: string; number?: string | null } = {},
) {
  return {
    message: {
      type: 'tool-calls',
      call: {
        id: overrides.callId ?? 'call_hook_1',
        ...(overrides.number === null ? {} : { customer: { number: overrides.number ?? CALLER } }),
      },
      toolCallList: calls,
    },
  };
}

function post(body: object, token = voiceToken) {
  return request(server).post(VOICE_WEBHOOK_PATH).set(DEVICE_TOKEN_HEADER, token).send(body);
}

/** The tool result is a JSON string, because that is what Vapi expects in `result`. */
function said(entry: { result?: string }): { say: string; options?: { ref: string }[] } {
  return JSON.parse(entry.result ?? '{}');
}

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.auditLog.deleteMany({
      where: { action: { in: ['device.created'] }, after: { path: '$.label', string_starts_with: PREFIX } },
    });
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('who may call the webhook', () => {
  beforeEach(reseed);

  it('refuses an unauthenticated POST with the shared envelope', async () => {
    const response = await request(server)
      .post(VOICE_WEBHOOK_PATH)
      .send(envelope([]))
      .expect(401);

    expect(response.body.error).toMatchObject({ code: expect.any(String) });
  });

  it('refuses a kiosk token — the type is a permission, not a label', async () => {
    await post(envelope([]), kioskToken).expect(403);
  });

  it('needs no CSRF token, because a header credential cannot be forged cross-site', async () => {
    // No cookie, no `x-csrf-token`, and it still works.
    await post(envelope([])).expect(200);
  });
});

describe.skipIf(!reachable)('reading the envelope', () => {
  beforeEach(reseed);

  it('answers one result per call, matched and ordered by id', async () => {
    const response = await post(
      envelope([
        { id: 'tc_a', name: 'get_shop_info', arguments: {} },
        { id: 'tc_b', name: 'list_services', arguments: {} },
      ]),
    ).expect(200);

    expect(response.body.results).toHaveLength(2);
    expect(response.body.results[0].toolCallId).toBe('tc_a');
    expect(response.body.results[1].toolCallId).toBe('tc_b');
  });

  it('accepts the name at `function.name` as well as at `name`', async () => {
    const response = await post(
      envelope([{ id: 'tc_fn', function: { name: 'list_services', arguments: {} } }]),
    ).expect(200);

    expect(said(response.body.results[0]).say).toContain(`${PREFIX}Haircut`);
  });

  it('accepts arguments as a JSON string, which some models send', async () => {
    const response = await post(
      envelope([
        { id: 'tc_str', name: 'list_services', arguments: JSON.stringify({ search: 'Haircut' }) },
      ]),
    ).expect(200);

    expect(said(response.body.results[0]).say).toContain(`${PREFIX}Haircut`);
  });

  it('ignores fields Vapi adds that we do not know about', async () => {
    // A strict schema would 400 here, and the caller would hear dead air over a key
    // that changes nothing.
    const response = await post({
      message: {
        type: 'tool-calls',
        somethingNew: { nested: true },
        call: { id: 'call_hook_1', customer: { number: CALLER }, orgId: 'org_x' },
        toolCallList: [{ id: 'tc_x', name: 'get_shop_info', arguments: {}, extra: 1 }],
      },
    }).expect(200);

    expect(response.body.results).toHaveLength(1);
  });

  it('acks a message type it does not handle rather than refusing it', async () => {
    // Refusing would earn retries forever for something we chose not to handle.
    const response = await post({
      message: { type: 'end-of-call-report', call: { id: 'call_hook_1' } },
    }).expect(200);

    expect(response.body).toEqual({});
  });
});

describe.skipIf(!reachable)('what a caller hears when something goes wrong', () => {
  beforeEach(reseed);

  it('speaks an unknown tool name instead of failing the exchange', async () => {
    const response = await post(
      envelope([{ id: 'tc_unknown', name: 'order_a_pizza', arguments: {} }]),
    ).expect(200);

    const entry = response.body.results[0];
    expect(entry.error).toBeUndefined();
    expect(said(entry).say).toMatch(/can't do that one/i);
  });

  it('puts an exposed refusal in `result`, so the assistant says the shop’s own words', async () => {
    const response = await post(
      envelope([
        { id: 'tc_bad', name: 'find_appointment_times', arguments: { services: ['Unicorn Trim'] } },
      ]),
    ).expect(200);

    const entry = response.body.results[0];
    expect(entry.error).toBeUndefined();
    // The service's own sentence, written for a customer, reaches the customer.
    expect(said(entry).say).toMatch(/don't have "Unicorn Trim"/i);
  });

  it('turns bad arguments into a question rather than a failure', async () => {
    const response = await post(
      envelope([{ id: 'tc_args', name: 'book_appointment', arguments: {} }]),
    ).expect(200);

    const entry = response.body.results[0];
    expect(entry.error).toBeUndefined();
    expect(said(entry).say).toMatch(/need a bit more/i);
  });

  it('never lets one failing call disturb its sibling', async () => {
    const response = await post(
      envelope([
        { id: 'tc_ok', name: 'get_shop_info', arguments: {} },
        { id: 'tc_fail', name: 'nope', arguments: {} },
      ]),
    ).expect(200);

    expect(response.body.results).toHaveLength(2);
    expect(said(response.body.results[0]).say).toBeTruthy();
    expect(response.body.results[1].toolCallId).toBe('tc_fail');
  });

  it('answers 200 even when every call in the envelope failed', async () => {
    // A non-2xx makes Vapi treat the whole exchange as failed, and the caller hears
    // silence — the worst outcome available.
    const response = await post(
      envelope([
        { id: 'tc_1', name: 'nope', arguments: {} },
        { id: 'tc_2', name: 'also_nope', arguments: {} },
      ]),
    ).expect(200);

    expect(response.body.results).toHaveLength(2);
  });
});

describe.skipIf(!reachable)('idempotency', () => {
  beforeEach(reseed);

  async function offerAndBook(toolCallId: string) {
    const offered = await post(
      envelope([
        {
          id: `find_${toolCallId}`,
          name: 'find_appointment_times',
          arguments: { services: [`${PREFIX}Haircut`], day: 'tuesday' },
        },
      ]),
    ).expect(200);

    const ref = said(offered.body.results[0]).options?.[0]?.ref ?? '';

    return post(
      envelope([
        {
          id: toolCallId,
          name: 'book_appointment',
          arguments: { option_ref: ref, first_name: 'Marcus' },
        },
      ]),
    ).expect(200);
  }

  it('replays a repeated toolCallId verbatim and books nothing twice', async () => {
    const first = await offerAndBook('tc_book_once');
    const firstSaid = said(first.body.results[0]);
    expect(firstSaid.say).toMatch(/you're booked/i);

    const before = await prisma.appointment.count({ where: { barberId } });

    // Vapi redelivering on timeout resends the SAME id.
    const replayed = await post(
      envelope([
        {
          id: 'tc_book_once',
          name: 'book_appointment',
          arguments: { option_ref: 'ignored-on-replay', first_name: 'Marcus' },
        },
      ]),
    ).expect(200);

    expect(said(replayed.body.results[0]).say).toBe(firstSaid.say);
    expect(await prisma.appointment.count({ where: { barberId } })).toBe(before);
  });

  it('does not record a read, because repeating one is free', async () => {
    await post(envelope([{ id: 'tc_read', name: 'get_shop_info', arguments: {} }])).expect(200);

    const recorded = await prisma.voiceToolCall.findUnique({ where: { toolCallId: 'tc_read' } });
    expect(recorded).toBeNull();
  });
});

describe.skipIf(!reachable)('the greeting hook', () => {
  beforeEach(reseed);

  it('answers with the assistant and a greeting for a caller it does not know', async () => {
    const response = await post({
      message: {
        type: 'assistant-request',
        call: { id: 'call_hook_greet', from: { phoneNumber: '+14155559999' } },
      },
    }).expect(200);

    // The id comes from the pinned fixture in `vitest.config.ts`, not from whatever the
    // developer happens to have provisioned.
    expect(response.body.assistantId).toBe('asst_fixture_not_a_real_assistant');
    expect(response.body.assistantOverrides.variableValues.callerKnown).toBe('no');
    expect(response.body.assistantOverrides.firstMessage).toMatch(/thanks for calling/i);
    // A stranger is greeted as one — no name volunteered, and nothing raw.
    expect(response.body.assistantOverrides.variableValues.callerFirstName).toBe('');
    expect(response.body.assistantOverrides.variableValues.appointmentSummary).toBe('');
  });

  it('reads the caller number from `from.phoneNumber` as well as `customer.number`', async () => {
    await prisma.client.create({ data: { phoneE164: CALLER, firstName: 'Marcus' } });

    // The docs put the number in two different places depending on the message type,
    // which is why the route reads both. This pins the `assistant-request` shape.
    const response = await post({
      message: {
        type: 'assistant-request',
        call: { id: 'call_hook_known', from: { phoneNumber: CALLER } },
      },
    }).expect(200);

    expect(response.body.assistantOverrides.variableValues.callerKnown).toBe('yes');
    expect(response.body.assistantOverrides.firstMessage).toContain('Hi Marcus');
  });
});

describe.skipIf(!reachable)('the audit trail', () => {
  beforeEach(reseed);

  it('attributes a phone booking to the voice device and to its call', async () => {
    const offered = await post(
      envelope([
        {
          id: 'tc_find_audit',
          name: 'find_appointment_times',
          arguments: { services: [`${PREFIX}Haircut`], day: 'tuesday' },
        },
      ]),
    ).expect(200);

    const ref = said(offered.body.results[0]).options?.[0]?.ref ?? '';

    const booked = await post(
      envelope(
        [
          {
            id: 'tc_book_audit',
            name: 'book_appointment',
            arguments: { option_ref: ref, first_name: 'Marcus' },
          },
        ],
        { callId: 'call_hook_audit' },
      ),
    ).expect(200);

    const appointmentId = JSON.parse(booked.body.results[0].result).booking.ref as string;

    const logged = await prisma.auditLog.findFirst({
      where: { action: 'appointment.created', entityId: appointmentId },
    });

    // A screen acts with nobody behind it, so the device is the only accountability there
    // is — and the Vapi call id is what leads back to a recording.
    expect(logged?.actorDeviceId).toBeTruthy();
    expect(logged?.actorUserId).toBeNull();
    expect(logged?.after).toMatchObject({ source: 'VOICE', vapiCallId: 'call_hook_audit' });

    const stored = await prisma.appointment.findUnique({ where: { id: appointmentId } });
    expect(stored?.source).toBe('VOICE');
  });
});
