/**
 * Staff authentication routes.
 *
 * Thin by design: parse, authorize, delegate. All the rules live in
 * `services/auth.ts` and `services/sessions.ts` so the Vapi voice router can reuse
 * them later without reimplementing lockout or session handling.
 *
 * Bodies are parsed with `schema.parse()` rather than a validation middleware: a
 * thrown ZodError is already turned into the shared 400 envelope by `errorHandler`,
 * and Express 5 forwards async rejections there automatically. That keeps the parsed
 * value fully typed instead of arriving as `any` on a request property.
 */

import {
  changePasswordRequestSchema,
  loginRequestSchema,
  type LoginResponse,
  type SessionUserDto,
} from '@francis/shared';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { env, isTest } from '../config/env.js';
import { clearSessionCookies, setSessionCookies } from '../lib/cookies.js';
import { NotFoundError, UnauthenticatedError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { toSessionUserDto } from '../mappers/auth.js';
import { requireUser } from '../middleware/require-auth.js';
import { changePassword, login } from '../services/auth.js';
import { createSession, revokeSession } from '../services/sessions.js';

export const authRouter: Router = Router();

/**
 * IP throttle in front of the per-account lockout. The lockout is the real defence;
 * this stops an attacker cheaply cycling through many accounts from one host, and
 * raises the cost of deliberately tripping another barber's lockout.
 *
 * Disabled under NODE_ENV=test, because the lockout tests need more attempts than
 * the limit allows.
 */
const loginRateLimit = rateLimit({
  windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  limit: env.LOGIN_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
});

async function loadSessionUser(userId: string): Promise<SessionUserDto> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: true, barber: { select: { id: true } } },
  });

  if (!user) throw new NotFoundError('Account not found.');

  return toSessionUserDto(
    user,
    user.roles.map((entry) => entry.role),
    user.barber?.id ?? null,
  );
}

authRouter.post('/auth/login', loginRateLimit, async (req, res) => {
  const { email, password } = loginRequestSchema.parse(req.body);

  const authenticated = await login(email, password);

  const session = await createSession({
    userId: authenticated.userId,
    ttlHours: env.SESSION_TTL_HOURS,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
  });

  setSessionCookies(res, session);

  const body: LoginResponse = {
    user: await loadSessionUser(authenticated.userId),
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt.toISOString(),
  };

  res.status(200).json(body);
});

authRouter.get('/auth/me', requireUser, async (req, res) => {
  if (req.auth?.kind !== 'user') throw new UnauthenticatedError();
  res.json({ user: await loadSessionUser(req.auth.userId) });
});

authRouter.post('/auth/logout', requireUser, async (req, res) => {
  if (req.auth?.kind !== 'user') throw new UnauthenticatedError();

  await revokeSession(req.auth.sessionId);
  clearSessionCookies(res);

  res.status(204).send();
});

authRouter.post('/auth/change-password', requireUser, async (req, res) => {
  if (req.auth?.kind !== 'user') throw new UnauthenticatedError();

  const { currentPassword, newPassword } = changePasswordRequestSchema.parse(req.body);

  await changePassword(req.auth.userId, currentPassword, newPassword);

  // changePassword revokes every session including this one, so the client must sign
  // in again with the new password.
  clearSessionCookies(res);

  res.status(204).send();
});
