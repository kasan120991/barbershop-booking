/**
 * Authentication logic.
 *
 * Plain functions over plain arguments — no `req`, no `res`. This is what lets the
 * Vapi voice router (and anything else) reuse the exact same rules later instead of
 * reimplementing them and inheriting none of the safety.
 */

import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import {
  generateTemporaryPassword,
  getDummyPasswordHash,
  hashPassword,
  verifyPassword,
} from './passwords.js';
import { revokeAllSessionsForUser } from './sessions.js';

/**
 * Locks the account after this many consecutive failures. An admin must unlock it.
 *
 * Known tradeoff of account lockout: someone who knows a barber's email can lock them
 * out on purpose. IP rate limiting sits in front of the login route to make reaching
 * this threshold harder, and admin unlock is one call.
 */
export const MAX_FAILED_LOGIN_ATTEMPTS = 10;

/** Minimum for a password a staff member chooses themselves. */
export const MIN_PASSWORD_LENGTH = 10;

export interface AuthenticatedUser {
  userId: string;
  email: string;
  mustChangePassword: boolean;
}

/**
 * Verifies credentials and enforces lockout.
 *
 * Every failure path throws the SAME error with the same message. Distinguishing
 * "no such account" from "wrong password" would confirm which emails are staff here.
 * The one exception is a locked account, which must be reported so the barber knows
 * to find the owner rather than retyping their password.
 */
export async function login(emailInput: string, password: string): Promise<AuthenticatedUser> {
  const email = emailInput.trim().toLowerCase();

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Burn equivalent CPU so response time does not reveal that the email is unknown.
    await verifyPassword(await getDummyPasswordHash(), password);
    throw new UnauthenticatedError('Incorrect email or password.');
  }

  if (user.lockedAt !== null) {
    throw new ForbiddenError(
      'This account is locked after too many failed sign-in attempts. Ask an admin to unlock it.',
    );
  }

  if (!user.isActive) {
    await verifyPassword(await getDummyPasswordHash(), password);
    throw new UnauthenticatedError('Incorrect email or password.');
  }

  const passwordMatches = await verifyPassword(user.passwordHash, password);

  if (!passwordMatches) {
    const attempts = user.failedLoginAttempts + 1;
    const nowLocked = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: attempts,
        ...(nowLocked ? { lockedAt: new Date() } : {}),
      },
    });

    if (nowLocked) {
      // Existing sessions die with the lock, or a stolen session outlives it.
      await revokeAllSessionsForUser(user.id);
      throw new ForbiddenError(
        'This account is now locked after too many failed sign-in attempts. Ask an admin to unlock it.',
      );
    }

    throw new UnauthenticatedError('Incorrect email or password.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lastLoginAt: new Date() },
  });

  return {
    userId: user.id,
    email: user.email,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * Self-service password change. Requires the current password, so a hijacked session
 * cannot be used to lock the real owner out of their own account.
 *
 * Revokes every session including the caller's — changing a password must not leave
 * an attacker's session alive.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ConflictError(`Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('Account not found.');

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new UnauthenticatedError('Your current password is incorrect.');
  }

  if (await verifyPassword(user.passwordHash, newPassword)) {
    throw new ConflictError('Your new password must be different from your current one.');
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedAt: null,
    },
  });

  await revokeAllSessionsForUser(userId);
}

/**
 * Admin-issued reset. The only recovery channel, since v1 sends no email or SMS —
 * the admin reads the temporary password to the barber in person.
 *
 * Returns the plaintext ONCE. It is never stored and cannot be retrieved again.
 */
export async function adminResetPassword(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('Staff member not found.');

  const temporaryPassword = generateTemporaryPassword();

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      failedLoginAttempts: 0,
      // A reset also unlocks — otherwise an admin would have to do two operations.
      lockedAt: null,
    },
  });

  await revokeAllSessionsForUser(userId);

  return temporaryPassword;
}

export async function unlockUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('Staff member not found.');

  await prisma.user.update({
    where: { id: userId },
    data: { lockedAt: null, failedLoginAttempts: 0 },
  });
}
