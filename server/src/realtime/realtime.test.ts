/**
 * The socket layer, against a real server on a real port.
 *
 * Mocking the transport would prove nothing here. The three things worth testing are
 * all properties of the wire: that a socket nobody can identify is refused, that a
 * mutation made over REST arrives at a connection that never asked for it, and — the
 * one that matters most — that the payload reaching a screen facing the shop floor
 * carries no phone number and no surname.
 *
 * Fixtures are namespaced to `@realtime.test` with cleanup scoped through the
 * relations, since the suite shares one database. Barbers get a shift covering all of
 * today, because the estimator has to place someone for the board to be interesting.
 */

import { DateTime } from 'luxon';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_HEADER } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../services/passwords.js';
import { closeRealtime, createRealtime } from './index.js';

const app = createApp();

const PREFIX = 'RTTEST ';
const PASSWORD = 'FrancisCutz!2026';
const ADMIN_EMAIL = 'admin@realtime.test';
const BARBER_EMAIL = 'barber@realtime.test';
const EMAILS = [ADMIN_EMAIL, BARBER_EMAIL];

const ALICE = '+14155550601';
const BOB = '+14155550602';
const PHONES = [ALICE, BOB];

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

const PASSWORD_HASH = await hashPassword(PASSWORD);

const TIMEZONE = 'America/New_York';
const todayWeekday = DateTime.now().setZone(TIMEZONE).weekday % 7;

let httpServer: HttpServer;
let port = 0;
let barberId = '';
let cutId = '';

/** Every socket opened by a test, closed in `afterEach` so none outlive their case. */
const open: Socket[] = [];

async function cleanup() {
  await prisma.queueEntryService.deleteMany({
    where: { queueEntry: { client: { phoneE164: { in: PHONES } } } },
  });
  await prisma.queueEntry.deleteMany({ where: { client: { phoneE164: { in: PHONES } } } });
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
  await prisma.shopHours.deleteMany({ where: { dayOfWeek: todayWeekday, openMinute: 0 } });
}

async function reseed() {
  await cleanup();

  await prisma.shopSettings.upsert({
    where: { id: 1 },
    update: {
      timezone: TIMEZONE,
      bufferMinutes: 0,
      minimumNoticeMinutes: 0,
      walkInQueueEnabled: true,
    },
    create: { id: 1, name: 'Francis Cutz', timezone: TIMEZONE },
  });
  await prisma.shopHours.create({
    data: { dayOfWeek: todayWeekday, openMinute: 0, closeMinute: 1440, isClosed: false },
  });

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: PASSWORD_HASH,
      firstName: 'Realtime',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });

  const barberUser = await prisma.user.create({
    data: {
      email: BARBER_EMAIL,
      passwordHash: PASSWORD_HASH,
      firstName: 'Rtest',
      lastName: 'Barber',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });
  const barber = await prisma.barber.create({
    data: { userId: barberUser.id, displayName: 'Rtest Marcus', slug: `rtest-${barberUser.id}` },
  });
  barberId = barber.id;

  await prisma.barberSchedule.create({
    data: { barberId, dayOfWeek: todayWeekday, startMinute: 0, endMinute: 1440 },
  });

  const cut = await prisma.service.create({
    data: { name: `${PREFIX}Haircut`, priceCents: 4500, durationMinutes: 30 },
  });
  cutId = cut.id;
  await prisma.barberService.create({ data: { barberId, serviceId: cutId } });
}

async function session(email: string) {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  const setCookie = response.headers['set-cookie'] as unknown as string[];
  return {
    cookies: setCookie,
    // A socket handshake sends one `Cookie` header, not the `Set-Cookie` list.
    header: setCookie.map((cookie) => cookie.split(';')[0]).join('; '),
    csrfToken: response.body.csrfToken as string,
  };
}

async function kioskToken(): Promise<string> {
  const admin = await session(ADMIN_EMAIL);
  const created = await request(app)
    .post('/api/devices')
    .set('Cookie', admin.cookies)
    .set(CSRF_HEADER, admin.csrfToken)
    .send({ label: `${PREFIX}Kiosk`, type: 'KIOSK' })
    .expect(201);

  const paired = await request(app)
    .post('/api/devices/pair')
    .send({ pairingCode: created.body.pairingCode })
    .expect(200);

  return paired.body.deviceToken as string;
}

function url(): string {
  return `http://127.0.0.1:${String(port)}`;
}

/** Tracks the socket so it cannot leak into the next test. */
function track(socket: Socket): Socket {
  open.push(socket);
  return socket;
}

/** Resolves on the first occurrence of an event, or rejects rather than hanging. */
function once<T>(socket: Socket, event: string, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);

    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

beforeAll(async () => {
  if (!reachable) return;
  httpServer = createServer(app);
  createRealtime(httpServer);
  // Port 0: the OS picks a free one, so the suite never collides with a dev server.
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  if (!reachable) return;
  for (const socket of open) socket.disconnect();
  await closeRealtime();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await cleanup();
  await prisma.$disconnect();
});

describe.skipIf(!reachable)('the handshake', () => {
  beforeEach(reseed);

  it('refuses a socket it cannot identify', async () => {
    const socket = track(connect(url(), { reconnection: false }));
    const error = await once<Error>(socket, 'connect_error');

    expect(error.message).toBe('unauthorized');
    expect(socket.connected).toBe(false);
  });

  it('refuses a session token that is not real', async () => {
    const socket = track(
      connect(url(), {
        reconnection: false,
        extraHeaders: { Cookie: 'fc_session=not-a-real-token' },
      }),
    );

    await expect(once<Error>(socket, 'connect_error')).resolves.toMatchObject({
      message: 'unauthorized',
    });
  });

  it('puts a signed-in barber in the shop room and their own', async () => {
    const staff = await session(BARBER_EMAIL);
    const socket = track(
      connect(url(), { reconnection: false, extraHeaders: { Cookie: staff.header } }),
    );

    const ready = await once<{ rooms: string[]; serverTime: string }>(socket, 'connection:ready');

    expect(ready.rooms).toContain('shop');
    expect(ready.rooms).toContain(`barber:${barberId}`);
    expect(Number.isNaN(Date.parse(ready.serverTime))).toBe(false);
  });

  it('puts a paired kiosk in the kiosk room and nowhere else', async () => {
    const token = await kioskToken();
    const socket = track(
      connect(url(), { reconnection: false, auth: { deviceToken: token } }),
    );

    const ready = await once<{ rooms: string[] }>(socket, 'connection:ready');

    expect(ready.rooms).toEqual(['kiosk']);
    // The room that carries phone numbers. A device must never be in it.
    expect(ready.rooms).not.toContain('shop');
  });

  /**
   * The precedence that makes a client-side rule load-bearing.
   *
   * A session cookie beats a device token on both transports, deliberately — a
   * signed-in barber using the shop tablet should be themselves. But cookies ignore
   * ports, so a browser used for both apps on one host carries the staff session to the
   * kiosk's own requests, and the socket would then join `shop` and receive full phone
   * numbers on a screen facing the room.
   *
   * Nothing on the server can distinguish the two cases. What keeps the kiosk safe is
   * that its client never sends credentials — no `withCredentials` on the socket, no
   * `credentials: 'include'` on fetch. This test is why that is a rule rather than a
   * preference.
   */
  it('puts a socket carrying BOTH a session cookie and a device token in shop', async () => {
    const staff = await session(BARBER_EMAIL);
    const token = await kioskToken();

    const socket = track(
      connect(url(), {
        reconnection: false,
        extraHeaders: { Cookie: staff.header },
        auth: { deviceToken: token },
      }),
    );

    const ready = await once<{ rooms: string[] }>(socket, 'connection:ready');

    expect(ready.rooms).toContain('shop');
    expect(ready.rooms).not.toContain('kiosk');
  });

  it('puts the same device in kiosk once the cookie is not sent', async () => {
    const token = await kioskToken();
    const socket = track(connect(url(), { reconnection: false, auth: { deviceToken: token } }));

    const ready = await once<{ rooms: string[] }>(socket, 'connection:ready');
    expect(ready.rooms).toEqual(['kiosk']);
  });

  it('refuses a device token that has been revoked', async () => {
    const token = await kioskToken();
    await prisma.device.updateMany({
      where: { label: { startsWith: PREFIX } },
      data: { revokedAt: new Date(), tokenHash: null },
    });

    const socket = track(connect(url(), { reconnection: false, auth: { deviceToken: token } }));

    await expect(once<Error>(socket, 'connect_error')).resolves.toMatchObject({
      message: 'unauthorized',
    });
  });
});

describe.skipIf(!reachable)('broadcasting', () => {
  beforeEach(reseed);

  /**
   * Sent without being asked for, so a client that reconnects after a dropped link is
   * correct at once instead of at the next mutation — which on a quiet afternoon could
   * be an hour away.
   */
  it('sends the current board the moment a staff socket connects', async () => {
    const staff = await session(BARBER_EMAIL);

    await request(app)
      .post('/api/queue')
      .set('Cookie', staff.cookies)
      .set(CSRF_HEADER, staff.csrfToken)
      .send({ phone: ALICE, firstName: 'Alice', lastName: 'Anderson', serviceIds: [cutId] })
      .expect(201);

    const socket = track(
      connect(url(), { reconnection: false, extraHeaders: { Cookie: staff.header } }),
    );
    const board = await once<{ entries: { clientName: string }[] }>(socket, 'queue:updated');

    expect(board.entries.map((entry) => entry.clientName)).toContain('Alice A.');
  });

  it('pushes a REST mutation to a socket that never asked for it', async () => {
    const staff = await session(BARBER_EMAIL);
    const socket = track(
      connect(url(), { reconnection: false, extraHeaders: { Cookie: staff.header } }),
    );

    // Wait for the connect-time board first, so the next one is unambiguously the
    // broadcast rather than the backfill.
    await once(socket, 'queue:updated');
    const broadcast = once<{ entries: { clientName: string }[] }>(socket, 'queue:updated');

    await request(app)
      .post('/api/queue')
      .set('Cookie', staff.cookies)
      .set(CSRF_HEADER, staff.csrfToken)
      .send({ phone: BOB, firstName: 'Bob', lastName: 'Brennan', serviceIds: [cutId] })
      .expect(201);

    expect((await broadcast).entries.map((entry) => entry.clientName)).toContain('Bob B.');
  });

  /**
   * The assertion this phase exists to keep honest. The kiosk and the wall display face
   * the whole room, and the payload is built by a different mapper for exactly this
   * reason — there is nowhere in its shape for a phone number to go.
   */
  it('never puts a phone number or a surname on the wire to a kiosk', async () => {
    const staff = await session(BARBER_EMAIL);
    const token = await kioskToken();
    const socket = track(connect(url(), { reconnection: false, auth: { deviceToken: token } }));

    await once(socket, 'queue:public');
    const broadcast = once<unknown>(socket, 'queue:public');

    await request(app)
      .post('/api/queue')
      .set('Cookie', staff.cookies)
      .set(CSRF_HEADER, staff.csrfToken)
      .send({ phone: ALICE, firstName: 'Alice', lastName: 'Anderson', serviceIds: [cutId] })
      .expect(201);

    const payload = JSON.stringify(await broadcast);
    expect(payload).not.toContain(ALICE);
    expect(payload).not.toContain('4155550601');
    expect(payload).not.toContain('Anderson');
    expect(payload).toContain('Alice A.');
  });

  it('never sends the staff board to a kiosk at all', async () => {
    const staff = await session(BARBER_EMAIL);
    const token = await kioskToken();
    const socket = track(connect(url(), { reconnection: false, auth: { deviceToken: token } }));

    const leaked: unknown[] = [];
    socket.on('queue:updated', (payload: unknown) => leaked.push(payload));

    await once(socket, 'queue:public');
    const redacted = once(socket, 'queue:public');

    await request(app)
      .post('/api/queue')
      .set('Cookie', staff.cookies)
      .set(CSRF_HEADER, staff.csrfToken)
      .send({ phone: ALICE, firstName: 'Alice', lastName: 'Anderson', serviceIds: [cutId] })
      .expect(201);

    await redacted;
    // The room is the boundary, so the full-board event must not arrive at all —
    // not merely arrive with less in it.
    expect(leaked).toEqual([]);
  });
});
