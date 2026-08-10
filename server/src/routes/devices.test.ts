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
    // The delete tests leave audit rows whose device is, by design, gone — so they
    // cannot be scoped by joining back to a fixture. Nothing else in the suite writes
    // this action, which is what keeps the filter this file's own.
    await prisma.auditLog.deleteMany({ where: { action: 'device.deleted' } });
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

  it('tells the screen which type it was paired as', async () => {
    // The only time the client is ever told. No later request returns it — not
    // `/queue/board`, not the socket handshake — so a screen that drops it here cannot
    // re-learn it across a reload, and both `/kiosk` and `/display` lose the ability to
    // say "you are the other one" before somebody has typed their phone number in.
    const kiosk = await createDevice('DEVTEST Door tablet', 'KIOSK');
    const wall = await createDevice('DEVTEST Wall panel', 'DISPLAY');

    const asKiosk = await request(server)
      .post('/api/devices/pair')
      .send({ pairingCode: kiosk.pairingCode })
      .expect(200);
    expect(asKiosk.body.type).toBe('KIOSK');

    const asDisplay = await request(server)
      .post('/api/devices/pair')
      .send({ pairingCode: wall.pairingCode })
      .expect(200);
    expect(asDisplay.body.type).toBe('DISPLAY');
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

describe.skipIf(!reachable)('removing a screen', () => {
  beforeEach(reseed);

  it('deletes a revoked device and records what it was', async () => {
    const { deviceId, admin } = await createDevice('DEVTEST Old counter');

    await request(server)
      .post(`/api/devices/${deviceId}/revoke`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .expect(204);

    await request(server)
      .delete(`/api/devices/${deviceId}`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .expect(204);

    expect(await prisma.device.findUnique({ where: { id: deviceId } })).toBeNull();

    // The label has to outlive the row. `AuditLog.actorDeviceId` has no foreign key, so
    // this entry is the only thing that can ever say which screen an older queue join
    // came from once the device itself is gone.
    const logged = await prisma.auditLog.findFirst({
      where: { action: 'device.deleted', entityId: deviceId },
    });
    expect(logged).not.toBeNull();
    expect(logged?.before).toMatchObject({ label: 'DEVTEST Old counter', type: 'KIOSK' });
  });

  it('refuses to delete a screen that has not been revoked', async () => {
    // The two-step is the safety property: one click on a list row must not be able to
    // unpair a tablet that is sitting in the shop working.
    const { deviceId, admin } = await createDevice('DEVTEST Live counter');

    const response = await request(server)
      .delete(`/api/devices/${deviceId}`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .expect(409);

    expect(response.body.error.message).toMatch(/revoke/i);
    expect(await prisma.device.findUnique({ where: { id: deviceId } })).not.toBeNull();
  });

  it('refuses to delete a paired screen that is still working', async () => {
    const { pairingCode, deviceId, admin } = await createDevice('DEVTEST Paired counter');
    const paired = await request(server).post('/api/devices/pair').send({ pairingCode }).expect(200);

    await request(server)
      .delete(`/api/devices/${deviceId}`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .expect(409);

    // Still authenticated: the refusal left the credential alone rather than half-doing
    // the job, which is what an unpaired-but-still-listed screen would be.
    await request(server)
      .get('/api/queue/board')
      .set(DEVICE_TOKEN_HEADER, paired.body.deviceToken)
      .expect(200);
  });

  it('requires admin to delete a device', async () => {
    const { deviceId, admin } = await createDevice('DEVTEST Someone elses');

    await request(server)
      .post(`/api/devices/${deviceId}/revoke`)
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .expect(204);

    await request(server).delete(`/api/devices/${deviceId}`).expect(401);
    expect(await prisma.device.findUnique({ where: { id: deviceId } })).not.toBeNull();
  });

  it('404s on a device that is already gone', async () => {
    const { admin } = await createDevice('DEVTEST Ghost');

    await request(server)
      .delete('/api/devices/does-not-exist')
      .set('Cookie', admin.cookies)
      .set(CSRF_HEADER, admin.csrfToken)
      .expect(404);
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
