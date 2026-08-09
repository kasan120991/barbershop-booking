/**
 * Password hashing (argon2id) and temporary-password generation.
 *
 * `@node-rs/argon2` is used rather than the `argon2` package because it ships
 * prebuilt native binaries — no node-gyp build, so it needs no `allowBuilds` entry
 * under pnpm 11's install-script blocking.
 */

import { randomInt } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP's argon2id baseline: 19 MiB memory, 2 iterations, parallelism 1.
 * Memory cost is what actually defeats GPU cracking, so it is the parameter to
 * raise first if these are ever tuned.
 *
 * `algorithm` is intentionally omitted: `@node-rs/argon2` defaults to Argon2id, and
 * its `Algorithm` export is an ambient `const enum`, which cannot be referenced under
 * `verbatimModuleSyntax`. Rather than hard-code the magic number, `passwords.test.ts`
 * asserts that produced hashes start with `$argon2id$` — so the default is verified
 * rather than assumed, and a change in the library breaks the build.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A hash of a throwaway value, computed once on first use.
 *
 * The login path verifies against this when an email does not exist, so it burns the
 * same CPU time as a real check. Without it a failed login returns measurably faster
 * for unknown emails, turning the login form into an oracle for "does this person
 * work here".
 *
 * Lazy rather than top-level `await` so importing this module stays synchronous.
 */
let dummyHashPromise: Promise<string> | undefined;

export function getDummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hash('not-a-real-password-timing-guard', ARGON2_OPTIONS);
  return dummyHashPromise;
}

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/** Never throws on a malformed stored hash — a corrupt row must fail closed, not 500. */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Words chosen to be unambiguous when spoken across a counter: no homophones, no
 * letters that sound alike, nothing that could be heard as another word on the list.
 */
const WORDS = [
  'anchor', 'basket', 'candle', 'dolphin', 'ember', 'falcon', 'granite', 'harbor',
  'ivory', 'jungle', 'kettle', 'lantern', 'marble', 'nectar', 'orchid', 'pepper',
  'quartz', 'ribbon', 'saddle', 'timber', 'umbrella', 'velvet', 'walnut', 'yonder',
] as const;

/**
 * A temporary password an admin reads to a barber in person — the only reset channel,
 * since v1 has no email or SMS.
 *
 * Format `word-word-1234`. Roughly 24*24*9000 ≈ 5.2M combinations, which is weak by
 * password standards and deliberately so: it is short-lived, forces a change at next
 * login, and its real threat model is being overheard, not brute-forced.
 */
export function generateTemporaryPassword(): string {
  const first = WORDS[randomInt(WORDS.length)] ?? 'anchor';
  let second = WORDS[randomInt(WORDS.length)] ?? 'basket';
  while (second === first) second = WORDS[randomInt(WORDS.length)] ?? 'basket';
  return `${first}-${second}-${randomInt(1000, 10_000)}`;
}
