/**
 * End-to-end auth behaviour through the real middleware stack.
 *
 * Uses the `francis_cutz_test` database and skips cleanly when it is unreachable, so
 * the suite still passes on a machine without MAMP running.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../config/constants.js';
import { prisma } from '../lib/prisma.js';
import { hashToken } from '../lib/tokens.js';
import { MAX_FAILED_LOGIN_ATTEMPTS } from '../services/auth.js';
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
const ADMIN_EMAIL = 'test-admin@auth.test';
const BARBER_EMAIL = 'test-barber@auth.test';

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

async function reseed() {
  await prisma.session.deleteMany({ where: { user: { email: { contains: '@auth.test' } } } });
  await prisma.userRole.deleteMany({ where: { user: { email: { contains: '@auth.test' } } } });
  await prisma.barber.deleteMany({ where: { user: { email: { contains: '@auth.test' } } } });
  await prisma.user.deleteMany({ where: { email: { contains: '@auth.test' } } });

  const passwordHash = await hashPassword(PASSWORD);

  const admin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash,
      firstName: 'Test',
      lastName: 'Admin',
      roles: { create: [{ role: 'ADMIN' }, { role: 'BARBER' }] },
    },
  });
  // The owner cuts hair too, so the admin also has a barber profile.
  await prisma.barber.create({
    data: { userId: admin.id, displayName: 'Test Admin', slug: `test-admin-${admin.id}` },
  });

  await prisma.user.create({
    data: {
      email: BARBER_EMAIL,
      passwordHash,
      firstName: 'Test',
      lastName: 'Barber',
      roles: { create: [{ role: 'BARBER' }] },
    },
  });
}

/** Signs in and returns the pieces later requests need. */
async function signIn(email = ADMIN_EMAIL, password = PASSWORD) {
  const response = await request(server)
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);

  const cookies = response.headers['set-cookie'] as unknown as string[];
  return {
    cookies,
    csrfToken: response.body.csrfToken as string,
    user: response.body.user,
  };
}

afterAll(async () => {
  if (reachable) {
    await prisma.user.deleteMany({ where: { email: { contains: '@auth.test' } } });
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('auth', () => {
  beforeEach(reseed);

  describe('POST /api/auth/login', () => {
    it('sets an httpOnly session cookie and a readable CSRF cookie', async () => {
      const response = await request(server)
        .post('/api/auth/login')
        .send({ email: ADMIN_EMAIL, password: PASSWORD })
        .expect(200);

      const cookies = (response.headers['set-cookie'] as unknown as string[]).join('; ');

      expect(cookies).toContain(SESSION_COOKIE);
      expect(cookies).toContain(CSRF_COOKIE);

      const sessionCookie = (response.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith(SESSION_COOKIE),
      );
      const csrfCookie = (response.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith(CSRF_COOKIE),
      );

      // The whole security model lives in this asymmetry.
      expect(sessionCookie).toContain('HttpOnly');
      expect(csrfCookie).not.toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Lax');
    });

    it('returns roles as a set, including the owner who also cuts hair', async () => {
      const { user } = await signIn();
      expect(user.roles.sort()).toEqual(['ADMIN', 'BARBER']);
      expect(user.barberId).toBeTruthy();
    });

    it('never returns the password hash', async () => {
      const response = await request(server)
        .post('/api/auth/login')
        .send({ email: ADMIN_EMAIL, password: PASSWORD })
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('argon2');
      expect(response.body.user).not.toHaveProperty('passwordHash');
    });

    it('stores only a hash — the cookie value is never in the database', async () => {
      const response = await request(server)
        .post('/api/auth/login')
        .send({ email: ADMIN_EMAIL, password: PASSWORD })
        .expect(200);

      const sessionCookie = (response.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith(SESSION_COOKIE),
      )!;
      const rawToken = sessionCookie.split('=')[1]!.split(';')[0]!;

      expect(await prisma.session.findUnique({ where: { tokenHash: rawToken } })).toBeNull();
      expect(await prisma.session.findUnique({ where: { tokenHash: hashToken(rawToken) } })).not.toBeNull();
    });

    it('rejects a wrong password and an unknown email identically', async () => {
      const wrongPassword = await request(server)
        .post('/api/auth/login')
        .send({ email: ADMIN_EMAIL, password: 'wrong-password' })
        .expect(401);

      const unknownEmail = await request(server)
        .post('/api/auth/login')
        .send({ email: 'nobody@auth.test', password: PASSWORD })
        .expect(401);

      // Identical responses, so the form cannot be used to enumerate staff accounts.
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
      expect(wrongPassword.body.error.code).toBe(unknownEmail.body.error.code);
    });

    it('rejects a malformed body with field errors', async () => {
      const response = await request(server)
        .post('/api/auth/login')
        .send({ email: 'not-an-email' })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.fields).toHaveProperty('email');
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns the signed-in user', async () => {
      const { cookies } = await signIn();
      const response = await request(server).get('/api/auth/me').set('Cookie', cookies).expect(200);
      expect(response.body.user.email).toBe(ADMIN_EMAIL);
    });

    it('401s without a session', async () => {
      const response = await request(server).get('/api/auth/me').expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('401s with a garbage cookie rather than 500ing', async () => {
      await request(server)
        .get('/api/auth/me')
        .set('Cookie', [`${SESSION_COOKIE}=not-a-real-token`])
        .expect(401);
    });
  });

  describe('logout', () => {
    it('revokes the session so the same cookie stops working', async () => {
      const { cookies, csrfToken } = await signIn();

      await request(server).get('/api/auth/me').set('Cookie', cookies).expect(200);

      await request(server)
        .post('/api/auth/logout')
        .set('Cookie', cookies)
        .set(CSRF_HEADER, csrfToken)
        .expect(204);

      await request(server).get('/api/auth/me').set('Cookie', cookies).expect(401);
    });
  });

  describe('session expiry', () => {
    it('rejects a session past its expiry', async () => {
      const { cookies } = await signIn();

      // Expire it directly rather than waiting 12 hours. Scoped to this file's own
      // users — an unscoped updateMany would expire sessions belonging to test files
      // running in parallel against the same database.
      await prisma.session.updateMany({
        where: { user: { email: { contains: '@auth.test' } } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(server).get('/api/auth/me').set('Cookie', cookies).expect(401);
    });

    it('does not slide the expiry — sessions are absolute', async () => {
      const { cookies } = await signIn();
      // Scoped for the same reason as above: another test file's session must not be
      // picked up here.
      const before = await prisma.session.findFirst({
        where: { user: { email: { contains: '@auth.test' } } },
      });

      await request(server).get('/api/auth/me').set('Cookie', cookies).expect(200);

      const after = await prisma.session.findFirst({ where: { id: before!.id } });
      expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    });
  });

  describe('CSRF', () => {
    it('rejects a mutation with no token', async () => {
      const { cookies } = await signIn();
      const response = await request(server).post('/api/auth/logout').set('Cookie', cookies).expect(403);
      expect(response.body.error.message).toMatch(/csrf/i);
    });

    it('rejects a token belonging to a different session', async () => {
      const first = await signIn();
      const second = await signIn();

      await request(server)
        .post('/api/auth/logout')
        .set('Cookie', first.cookies)
        .set(CSRF_HEADER, second.csrfToken)
        .expect(403);
    });

    it('accepts the matching token', async () => {
      const { cookies, csrfToken } = await signIn();
      await request(server)
        .post('/api/auth/logout')
        .set('Cookie', cookies)
        .set(CSRF_HEADER, csrfToken)
        .expect(204);
    });

    it('does not require a token for a safe method', async () => {
      const { cookies } = await signIn();
      await request(server).get('/api/auth/me').set('Cookie', cookies).expect(200);
    });
  });

  describe('account lockout', () => {
    it(`locks after ${MAX_FAILED_LOGIN_ATTEMPTS} failures and then rejects the CORRECT password`, async () => {
      for (let attempt = 1; attempt < MAX_FAILED_LOGIN_ATTEMPTS; attempt += 1) {
        await request(server)
          .post('/api/auth/login')
          .send({ email: BARBER_EMAIL, password: 'wrong' })
          .expect(401);
      }

      // The threshold attempt reports the lock rather than a generic failure, so the
      // barber knows to find the owner instead of retyping.
      const locking = await request(server)
        .post('/api/auth/login')
        .send({ email: BARBER_EMAIL, password: 'wrong' })
        .expect(403);
      expect(locking.body.error.message).toMatch(/locked/i);

      // The real proof: the right password no longer works.
      const afterLock = await request(server)
        .post('/api/auth/login')
        .send({ email: BARBER_EMAIL, password: PASSWORD })
        .expect(403);
      expect(afterLock.body.error.message).toMatch(/locked/i);
    });

    it('resets the counter on a successful login', async () => {
      for (let attempt = 0; attempt < MAX_FAILED_LOGIN_ATTEMPTS - 1; attempt += 1) {
        await request(server)
          .post('/api/auth/login')
          .send({ email: BARBER_EMAIL, password: 'wrong' })
          .expect(401);
      }

      await signIn(BARBER_EMAIL);

      const user = await prisma.user.findUnique({ where: { email: BARBER_EMAIL } });
      expect(user?.failedLoginAttempts).toBe(0);
      expect(user?.lockedAt).toBeNull();
    });

    it('kills existing sessions when the account locks', async () => {
      const { cookies } = await signIn(BARBER_EMAIL);
      await request(server).get('/api/auth/me').set('Cookie', cookies).expect(200);

      for (let attempt = 0; attempt < MAX_FAILED_LOGIN_ATTEMPTS; attempt += 1) {
        await request(server).post('/api/auth/login').send({ email: BARBER_EMAIL, password: 'wrong' });
      }

      // A session that predates the lock must not outlive it.
      await request(server).get('/api/auth/me').set('Cookie', cookies).expect(401);
    });
  });

  describe('authorization', () => {
    it('403s a BARBER on an admin-only route', async () => {
      const { cookies, csrfToken } = await signIn(BARBER_EMAIL);

      const response = await request(server)
        .post('/api/devices')
        .set('Cookie', cookies)
        .set(CSRF_HEADER, csrfToken)
        .send({ label: 'Front counter', type: 'KIOSK' })
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('allows an ADMIN', async () => {
      const { cookies, csrfToken } = await signIn(ADMIN_EMAIL);

      await request(server)
        .post('/api/devices')
        .set('Cookie', cookies)
        .set(CSRF_HEADER, csrfToken)
        .send({ label: 'Front counter', type: 'KIOSK' })
        .expect(201);
    });

    it('401s an anonymous request to an admin route', async () => {
      await request(server).get('/api/devices').expect(401);
    });
  });

  describe('admin password reset', () => {
    it('issues a temporary password, forces a change, and revokes sessions', async () => {
      const barberSession = await signIn(BARBER_EMAIL);
      const admin = await signIn(ADMIN_EMAIL);

      const barber = await prisma.user.findUnique({ where: { email: BARBER_EMAIL } });

      const response = await request(server)
        .post(`/api/staff/${barber!.id}/reset-password`)
        .set('Cookie', admin.cookies)
        .set(CSRF_HEADER, admin.csrfToken)
        .expect(200);

      expect(response.body.temporaryPassword).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);

      // The barber's existing session dies with the reset.
      await request(server).get('/api/auth/me').set('Cookie', barberSession.cookies).expect(401);

      // The old password no longer works; the temporary one does.
      await request(server)
        .post('/api/auth/login')
        .send({ email: BARBER_EMAIL, password: PASSWORD })
        .expect(401);

      const withTemp = await request(server)
        .post('/api/auth/login')
        .send({ email: BARBER_EMAIL, password: response.body.temporaryPassword })
        .expect(200);

      expect(withTemp.body.user.mustChangePassword).toBe(true);
    });

    it('unlocks a locked account', async () => {
      for (let attempt = 0; attempt < MAX_FAILED_LOGIN_ATTEMPTS; attempt += 1) {
        await request(server).post('/api/auth/login').send({ email: BARBER_EMAIL, password: 'wrong' });
      }
      await request(server)
        .post('/api/auth/login')
        .send({ email: BARBER_EMAIL, password: PASSWORD })
        .expect(403);

      const admin = await signIn(ADMIN_EMAIL);
      const barber = await prisma.user.findUnique({ where: { email: BARBER_EMAIL } });

      await request(server)
        .post(`/api/staff/${barber!.id}/unlock`)
        .set('Cookie', admin.cookies)
        .set(CSRF_HEADER, admin.csrfToken)
        .expect(204);

      await request(server)
        .post('/api/auth/login')
        .send({ email: BARBER_EMAIL, password: PASSWORD })
        .expect(200);
    });

    it('403s a BARBER trying to reset someone else', async () => {
      const barberSession = await signIn(BARBER_EMAIL);
      const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

      await request(server)
        .post(`/api/staff/${admin!.id}/reset-password`)
        .set('Cookie', barberSession.cookies)
        .set(CSRF_HEADER, barberSession.csrfToken)
        .expect(403);
    });
  });

  describe('change password', () => {
    it('requires the current password and then revokes every session', async () => {
      const { cookies, csrfToken } = await signIn(BARBER_EMAIL);

      await request(server)
        .post('/api/auth/change-password')
        .set('Cookie', cookies)
        .set(CSRF_HEADER, csrfToken)
        .send({ currentPassword: 'wrong', newPassword: 'a-brand-new-password' })
        .expect(401);

      await request(server)
        .post('/api/auth/change-password')
        .set('Cookie', cookies)
        .set(CSRF_HEADER, csrfToken)
        .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' })
        .expect(204);

      // Changing a password must not leave an attacker's session alive.
      await request(server).get('/api/auth/me').set('Cookie', cookies).expect(401);

      await request(server)
        .post('/api/auth/login')
        .send({ email: BARBER_EMAIL, password: 'a-brand-new-password' })
        .expect(200);
    });

    it('rejects a too-short new password', async () => {
      const { cookies, csrfToken } = await signIn(BARBER_EMAIL);

      await request(server)
        .post('/api/auth/change-password')
        .set('Cookie', cookies)
        .set(CSRF_HEADER, csrfToken)
        .send({ currentPassword: PASSWORD, newPassword: 'short' })
        .expect(400);
    });
  });
});
