/**
 * Opaque credential tokens: session tokens, CSRF tokens, device tokens, pairing codes.
 *
 * These are hashed with **SHA-256, not argon2**, and that is a deliberate choice
 * rather than a shortcut.
 *
 * Argon2 is slow on purpose, to make low-entropy human passwords expensive to guess
 * at scale. A 256-bit random token has nothing to guess — an attacker holding the
 * hash cannot brute-force the preimage regardless of how fast the hash is. The only
 * property we need is that a database leak does not yield usable tokens, and a plain
 * cryptographic hash gives us exactly that. Using argon2 here would add ~100 ms to
 * EVERY authenticated request and buy nothing.
 *
 * Passwords are the opposite case and go through `services/passwords.ts` (argon2id).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes = 256 bits of entropy. base64url so it is cookie- and URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two hex hashes.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak information,
 * so the length check is done first and returns a plain false.
 */
export function safeCompareHashes(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * A pairing code a human reads off a screen and types into a tablet.
 *
 * Digits only, in two groups, because it gets read aloud across a counter. The
 * alphabet excludes nothing (0-9 are unambiguous when grouped), and 8 digits gives
 * 100M combinations — ample given the code lives for 15 minutes, is single-use, and
 * grants only queue access.
 */
export function generatePairingCode(): string {
  const digits = randomBytes(8).reduce((acc, byte) => acc + String(byte % 10), '');
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}`;
}

/** Strips formatting so "4820-1937", "48201937", and " 4820 1937 " all match. */
export function normalizePairingCode(input: string): string {
  const digits = input.replace(/\D/g, '');
  return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 8)}` : input.trim();
}
