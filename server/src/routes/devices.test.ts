/**
 * Kiosk pairing lifecycle and scope.
 *
 * The scope tests matter as much as the pairing ones: a device token must not be a
 * back door into staff-only data.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_HEADER, DEVICE_TOKEN_HEADER } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';
import { hashToken } from '../lib/tokens.js';
import { hashPassword } from '../services/passwords.js';

const app = createApp();

/**
 * One listening server for the whole file.
 *
 * `request(app)` starts an ephemeral server and closes it again for EVERY request.
 * That churn is what produced the intermittent "socket hang up" and "Parse Error:
 * Expected HTTP/" failures — a client socket outliving the server it was talking to.
 * They landed in whichever file happened to be running, which is why they read as
 * database contention for two phases. Binding once removes the whole class.
 */
const server = app.listen(0);
afterAll(() => {
  server.close();
});

const PASSWORD = 'FrancisCutz!2026';
const ADMIN_EMAIL = 'admin@devices.test';

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

async function reseed() {
  await prisma.device.deleteMany({ where: { label: { startsWith: 'DEVTEST ' } } });
  await prisma.userRole.deleteMany({ where: { user: { email: ADMIN_EMAIL } } });
  await prisma.user.deleteMany({ where: { email: ADMIN_EMAIL } });

  await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Device',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }] },
    },
  });
}

async function adminSession() {
  const response = await request(server)
    .post('/api/auth/login')
    .send({ email: ADMIN_EMAIL, password: PASSWORD })
    .expect(200);

  return {
    cookies: response.headers['set-cookie'] as unknown as string[],
    csrfToken: response.body.csrfToken as string,
  };
}

async function createDevice(label = 'DEVTEST Front counter', type = 'KIOSK') {
  const admin = await adminSession();
  const response = await request(server)
    .post('/api/devices')
    .set('Cookie', admin.cookies)
    .set(CSRF_HEADER, admin.csrfToken)
    .send({ label, type })
    .expect(201);
  return { admin, ...response.body };
}

afterAll(async () => {
  if (reachable) {
    await prisma.device.deleteMany({ where: { label: { startsWith: 'DEVTEST ' } } });
    await prisma.user.deleteMany({ where: { email: ADMIN_EMAIL } });
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('device pairing', () => {
  beforeEach(reseed);

  it('issues a readable pairing code and stores only its hash', async () => {
    const { pairingCode, deviceId } = await createDevice();

    expect(pairingCode).toMatch(/^\d{4}-\d{4}$/);

    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(device?.pairingCodeHash).toBe(hashToken(pairingCode));
    expect(device?.pairingCodeHash).not.toBe(pairingCode);
    // Not paired yet.
    expect(device?.tokenHash).toBeNull();
  });

  it('redeems a code for a device token', async () => {
    const { pairingCode, deviceId } = await createDevice();

    const response = await request(server)
      .post('/api/devices/pair')
      .send({ pairingCode })
      .expect(200);

    expect(response.body.deviceToken).toBeTruthy();

    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(device?.tokenHash).toBe(hashToken(response.body.deviceToken));
    // Clearing the code is what makes redemption single-use.
    expect(device?.pairingCodeHash).toBeNull();
    expect(device?.pairedAt).not.toBeNull();
  });

  it('accepts the code without its separator', async () => {
    const { pairingCode } = await createDevice();
    await request(server)
      .post('/api/devices/pair')
      .send({ pairingCode: pairingCode.replace('-', '') })
      .expect(200);
  });

  it('refuses to redeem the same code twice', async () => {
    const { pairingCode } = await createDevice();

    await request(server).post('/api/devices/pair').send({ pairingCode }).expect(200);

    const second = await request(server).post('/api/devices/pair').send({ pairingCode }).expect(404);
    expect(second.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects an expired code', async () => {
    const { pairingCode, deviceId } = await createDevice();

    await prisma.device.update({
      where: { id: deviceId },
      data: { pairingCodeExpiresAt: new Date(Date.now() - 1000) },
    });

    const response = await request(server)
      .post('/api/devices/pair')
      .send({ pairingCode })
      .expect(409);
    expect(response.body.error.message).toMatch(/expired/i);
  });

  it('rejects an unknown code', async () => {
    await request(server).post('/api/devices/pair').send({ pairingCode: '0000-0000' }).expect(404);
  });

  it('requires admin to create a device', async () => {
    await request(server).post('/api/devices').send({ label: 'DEVTEST x', type: 'KIOSK' }).expect(401);
  });
});

describe.skipIf(!reachable)('device token scope', () => {
  beforeEach(reseed);

  it('authenticates the device but cannot reach an admin route', async () => {
    const { pairingCode } = await createDevice();
    const paired = await request(server).post('/api/devices/pair').send({ pairingCode }).expect(200);

    // The kiosk is authenticated — but a device principal has no roles, so it can
    // never satisfy requireRole(ADMIN). This is the property the union type enforces.
    const response = await request(server)
      .get('/api/devices')
      .set(DEVICE_TOKEN_HEADER, paired.body.deviceToken)
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('stops working once revoked', async () => {
    const { pairingCode, deviceId, admin } = await createDevice();
    const paired = await request(server).post('/api/devices/pair').send({ pairingCode }).expect(200);

    await request(server)
      .post(`/api/devices/${deviceId}/revoke`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .expect(204);

    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    // Revoking clears the token outright, so a stolen tablet cannot be re-enabled.
    expect(device?.tokenHash).toBeNull();
    expect(device?.revokedAt).not.toBeNull();

    await request(server)
      .get('/api/auth/me')
      .set(DEVICE_TOKEN_HEADER, paired.body.deviceToken)
      .expect(401);
  });

  it('is exempt from CSRF, having no ambient cookie credential', async () => {
    const { pairingCode } = await createDevice();
    const paired = await request(server).post('/api/devices/pair').send({ pairingCode }).expect(200);

    // A device POST with no CSRF header must not be rejected for CSRF. It gets 401
    // here only because /devices is admin-only — which is the point of the check.
    const response = await request(server)
      .post('/api/devices')
      .set(DEVICE_TOKEN_HEADER, paired.body.deviceToken)
      .send({ label: 'DEVTEST nope', type: 'KIOSK' });

    expect(response.status).toBe(401);
    expect(response.body.error.message).not.toMatch(/csrf/i);
  });
});

describe.skipIf(!reachable)('device DTO', () => {
  beforeEach(reseed);

  it('never exposes a token or pairing hash to the admin list', async () => {
    const { pairingCode, admin } = await createDevice();
    await request(server).post('/api/devices/pair').send({ pairingCode }).expect(200);

    const response = await request(server).get('/api/devices').set('Cookie', admin.cookies).expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain('pairingCodeHash');
    expect(serialized).not.toContain(pairingCode);

    const device = response.body.devices.find((d: { label: string }) => d.label === 'DEVTEST Front counter');
    expect(device.status).toBe('PAIRED');
  });
});
