import { describe, expect, it } from 'vitest';

import { generateTemporaryPassword, hashPassword, verifyPassword } from './passwords.js';

describe('hashPassword', () => {
  it('produces an argon2id hash', async () => {
    // Verifies the library default rather than assuming it — `algorithm` is omitted
    // from the options because its enum cannot be imported under verbatimModuleSyntax.
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('never contains the plaintext', async () => {
    const password = 'FrancisCutz!2026';
    const hash = await hashPassword(password);
    expect(hash).not.toContain(password);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    const hash = await hashPassword('FrancisCutz!2026');
    expect(await verifyPassword(hash, 'FrancisCutz!2026')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('FrancisCutz!2026');
    expect(await verifyPassword(hash, 'franciscutz!2026')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('fails closed on a corrupt stored hash instead of throwing', async () => {
    // A malformed row must produce a failed login, not a 500 that leaks a stack trace.
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });
});

describe('generateTemporaryPassword', () => {
  it('is readable aloud: word-word-digits', () => {
    expect(generateTemporaryPassword()).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
  });

  it('never repeats the same word twice', () => {
    for (let i = 0; i < 50; i += 1) {
      const [first, second] = generateTemporaryPassword().split('-');
      expect(first).not.toBe(second);
    }
  });

  it('does not return a constant', () => {
    const generated = new Set(Array.from({ length: 20 }, () => generateTemporaryPassword()));
    expect(generated.size).toBeGreaterThan(1);
  });
});
