/**
 * Session lifecycle.
 *
 * Sessions are database-backed rather than stateless JWTs, for two reasons that both
 * matter here: an admin must be able to revoke a barber's access immediately (a JWT
 * stays valid until it expires), and Socket.IO must authenticate a handshake using
 * exactly the same lookup as the HTTP middleware.
 *
 * Only hashes are stored. The raw tokens are returned once, to be set as cookies,
 * and never persisted anywhere.
 */

import { isTest } from '../config/env.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import { prisma } from '../lib/prisma.js';
import type { Role } from '../generated/prisma/enums.js';

export interface IssuedSession {
  sessionId: string;
  /** Raw — goes in the httpOnly cookie. Never logged, never stored. */
  sessionToken: string;
  /** Raw — goes in the JS-readable cookie for the double-submit check. */
  csrfToken: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  roles: Role[];
  barberId: string | null;
  csrfTokenHash: string;
  mustChangePassword: boolean;
}

export interface CreateSessionInput {
  userId: string;
  ttlHours: number;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export async function createSession(input: CreateSessionInput): Promise<IssuedSession> {
  const sessionToken = generateToken();
  const csrfToken = generateToken();
  const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60 * 1000);

  const session = await prisma.session.create({
    data: {
      tokenHash: hashToken(sessionToken),
      csrfTokenHash: hashToken(csrfToken),
      userId: input.userId,
      expiresAt,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
    },
  });

  return { sessionId: session.id, sessionToken, csrfToken, expiresAt };
}

/**
 * Returns null for anything not currently valid — unknown, revoked, expired, or
 * belonging to a deactivated user. Callers treat null as "not authenticated" and
 * never need to distinguish the reasons, which also avoids leaking them.
 *
 * Sessions are 12-hour ABSOLUTE: this deliberately does not extend `expiresAt`.
 */
export async function resolveSession(rawToken: string): Promise<ResolvedSession | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: {
      user: {
        include: { roles: true, barber: { select: { id: true } } },
      },
    },
  });

  if (!session) return null;
  if (session.revokedAt !== null) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.user.isActive) return null;
  // A locked account must lose its existing sessions too, not just future logins.
  if (session.user.lockedAt !== null) return null;

  return {
    sessionId: session.id,
    userId: session.userId,
    roles: session.user.roles.map((entry) => entry.role),
    barberId: session.user.barber?.id ?? null,
    csrfTokenHash: session.csrfTokenHash,
    mustChangePassword: session.user.mustChangePassword,
  };
}

/**
 * Best-effort activity stamp. Never awaited on the request path — a failed write
 * here must not fail an otherwise good request.
 *
 * Skipped under test: because it is deliberately not awaited, the UPDATE can still be
 * in flight when the next test's cleanup DELETEs the same rows, and InnoDB resolves
 * that collision by killing one of them as a deadlock. It stamps a column nothing
 * asserts, so running it during tests buys nothing and costs intermittent failures in
 * whichever file happened to be next.
 */
export function touchSession(sessionId: string): void {
  if (isTest) return;
  void prisma.session
    .update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Used on password change and admin reset — a new password must invalidate old sessions. */
export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Housekeeping for a scheduled job; expired rows are already rejected on read. */
export async function deleteExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
