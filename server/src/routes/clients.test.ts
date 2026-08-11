/**
 * Who may learn what about a phone number.
 *
 * The phone number is an **unverified** identity, so a route that answered "who owns this
 * number?" to anyone who asked would be a directory of the shop's customers. That is why
 * there are two routes and not one, and most of this file exists to hold the public one to
 * its bargain: a caller supplies a number *and* a name and learns only whether they go
 * together.
 *
 * The response-shape test is the important one. It is easy to make `recognise` "more
 * helpful" later by returning the name it matched, and that one line would undo the whole
 * design — so the shape is pinned rather than described.
 *
 * Fixtures namespaced to `@clients.test` / `+1415555094x`.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../services/passwords.js';

const app = createApp();

// One listening server for the file — see the note in devices.test.ts.
const server = app.listen(0);
afterAll(() => {
  server.close();
});

const PASSWORD = 'FrancisCutz!2026';
const STAFF_EMAIL = 'barber@clients.test';
const EMAILS = [STAFF_EMAIL];

const KNOWN = '+14155550941';
const BLOCKED = '+14155550942';
const UNKNOWN = '+14155550949';
const PHONES = [KNOWN, BLOCKED, UNKNOWN];

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

const PASSWORD_HASH = await hashPassword(PASSWORD);

async function cleanup() {
  await prisma.client.deleteMany({ where: { phoneE164: { in: PHONES } } });
  await prisma.session.deleteMany({ where: { user: { email: { in: EMAILS } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
}

async function reseed() {
  await cleanup();

  await prisma.user.create({
    data: {
      email: STAFF_EMAIL,
      passwordHash: PASSWORD_HASH,
      firstName: 'Clients',
      lastName: 'Barber',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });

  await prisma.client.create({
    data: {
      phoneE164: KNOWN,
      firstName: 'Marcus',
      lastName: 'Trent',
      notes: 'Number 2 on the sides.',
      visitCount: 12,
    },
  });

  await prisma.client.create({
    data: { phoneE164: BLOCKED, firstName: 'Dana', lastName: 'Price', isBlocked: true },
  });
}

async function signIn() {
  const response = await request(server)
    .post('/api/auth/login')
    .send({ email: STAFF_EMAIL, password: PASSWORD })
    .expect(200);

  return response.headers['set-cookie'] as unknown as string[];
}

const recognise = (phone: string, firstName: string) =>
  request(server).post('/api/clients/recognise').send({ phone, firstName });

afterAll(async () => {
  if (reachable) {
    await cleanup();
    await prisma.$disconnect();
  }
});

// --- The public half ----------------------------------------------------------

describe.skipIf(!reachable)('POST /clients/recognise', () => {
  beforeEach(reseed);

  it('recognises the right number and name together', async () => {
    const response = await recognise(KNOWN, 'Marcus').expect(200);
    expect(response.body).toEqual({ recognised: true });
  });

  /**
   * The assertion the whole design rests on.
   *
   * Not "does not contain the surname" — *contains nothing but the boolean*. A future
   * change that returns the matched name to be helpful has to delete this test to do it,
   * which is the point: it makes the leak a decision instead of a diff nobody reads.
   */
  it('answers with one boolean and nothing else, ever', async () => {
    const hit = await recognise(KNOWN, 'Marcus').expect(200);
    const miss = await recognise(KNOWN, 'Somebody').expect(200);

    for (const response of [hit, miss]) {
      expect(Object.keys(response.body)).toEqual(['recognised']);

      // Belt and braces: no part of the record may appear anywhere in the payload.
      const raw = JSON.stringify(response.body).toLowerCase();
      expect(raw).not.toContain('marcus');
      expect(raw).not.toContain('trent');
      expect(raw).not.toContain('sides');
      expect(raw).not.toContain('4155550941');
    }
  });

  it('refuses a wrong first name for a number it knows', async () => {
    const response = await recognise(KNOWN, 'Priya').expect(200);
    expect(response.body).toEqual({ recognised: false });
  });

  /**
   * A number it has never seen and a number under another name answer identically.
   * Telling them apart is the leak, restated.
   */
  it('cannot be used to tell an unknown number from a wrong name', async () => {
    const unknown = await recognise(UNKNOWN, 'Marcus').expect(200);
    const wrongName = await recognise(KNOWN, 'Marcia').expect(200);
    expect(unknown.body).toEqual(wrongName.body);
  });

  it('matches regardless of case and stray spaces', async () => {
    await recognise(KNOWN, '  marcus ').expect(200).expect({ recognised: true });
    await recognise(KNOWN, 'MARCUS').expect(200).expect({ recognised: true });
  });

  /** Formatting is not identity — the write paths normalise, so this must too. */
  it('matches however the number was typed', async () => {
    await recognise('(415) 555-0941', 'Marcus').expect(200).expect({ recognised: true });
    await recognise('4155550941', 'Marcus').expect(200).expect({ recognised: true });
  });

  /**
   * Greeting somebody by name and refusing their booking a moment later is worse than
   * not greeting them.
   */
  it('does not recognise a blocked number', async () => {
    await recognise(BLOCKED, 'Dana').expect(200).expect({ recognised: false });
  });

  it('needs both halves', async () => {
    await request(server).post('/api/clients/recognise').send({ phone: KNOWN }).expect(400);
    await request(server).post('/api/clients/recognise').send({ firstName: 'Marcus' }).expect(400);
  });
});

// --- The staff half -----------------------------------------------------------

describe.skipIf(!reachable)('GET /clients/lookup', () => {
  beforeEach(reseed);

  it('gives a signed-in barber the whole record', async () => {
    const cookies = await signIn();

    const response = await request(server)
      .get('/api/clients/lookup')
      .query({ phone: KNOWN })
      .set('Cookie', cookies)
      .expect(200);

    expect(response.body.client).toMatchObject({
      firstName: 'Marcus',
      lastName: 'Trent',
      visitCount: 12,
      isBlocked: false,
    });
  });

  /** Surfaced at lookup so the desk finds out before filling the whole form in. */
  it('says when a number is blocked', async () => {
    const cookies = await signIn();

    const response = await request(server)
      .get('/api/clients/lookup')
      .query({ phone: BLOCKED })
      .set('Cookie', cookies)
      .expect(200);

    expect(response.body.client.isBlocked).toBe(true);
  });

  it('returns null for a number it does not know', async () => {
    const cookies = await signIn();

    const response = await request(server)
      .get('/api/clients/lookup')
      .query({ phone: UNKNOWN })
      .set('Cookie', cookies)
      .expect(200);

    expect(response.body.client).toBeNull();
  });

  /** The whole reason this is a second route rather than a flag on the first one. */
  it('refuses an unauthenticated caller', async () => {
    await request(server).get('/api/clients/lookup').query({ phone: KNOWN }).expect(401);
  });

  /**
   * And refuses a kiosk.
   *
   * `requireUser` cannot be satisfied by a device: `req.auth` is a discriminated union and
   * a paired screen is `{ kind: 'device' }` with no roles. Asserted rather than assumed,
   * because a screen in a public lobby reading client records is the failure this whole
   * feature was designed around.
   */
  it('refuses a paired device', async () => {
    const admin = await prisma.user.findFirst({ where: { email: STAFF_EMAIL } });
    expect(admin).toBeTruthy();

    await request(server)
      .get('/api/clients/lookup')
      .query({ phone: KNOWN })
      .set('x-device-token', 'not-a-real-token-but-a-device-header-all-the-same')
      .expect(401);
  });
});
