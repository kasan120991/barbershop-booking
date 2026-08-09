import { describe, expect, it } from 'vitest';

import {
  generatePairingCode,
  generateToken,
  hashToken,
  normalizePairingCode,
  safeCompareHashes,
} from './tokens.js';

describe('generateToken', () => {
  it('is 256 bits, base64url encoded', () => {
    const token = generateToken();
    // 32 bytes -> 43 base64url chars, unpadded.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is cookie- and URL-safe', () => {
    for (let i = 0; i < 50; i += 1) {
      const token = generateToken();
      expect(token).not.toContain('+');
      expect(token).not.toContain('/');
      expect(token).not.toContain('=');
      expect(token).not.toContain(';');
    }
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken()));
    expect(tokens.size).toBe(500);
  });
});

describe('hashToken', () => {
  it('is deterministic', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('never returns the input', () => {
    const token = generateToken();
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).not.toContain(token);
  });

  it('is a 64-char hex sha256 digest', () => {
    expect(hashToken(generateToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('safeCompareHashes', () => {
  it('matches identical values', () => {
    const hash = hashToken('token');
    expect(safeCompareHashes(hash, hash)).toBe(true);
  });

  it('rejects different values', () => {
    expect(safeCompareHashes(hashToken('a'), hashToken('b'))).toBe(false);
  });

  it('returns false on a length mismatch rather than throwing', () => {
    // timingSafeEqual throws on unequal lengths, which would itself be a signal.
    expect(safeCompareHashes('short', hashToken('a'))).toBe(false);
    expect(safeCompareHashes('', '')).toBe(true);
  });
});

describe('generatePairingCode', () => {
  it('is two groups of four digits', () => {
    expect(generatePairingCode()).toMatch(/^\d{4}-\d{4}$/);
  });

  it('varies', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generatePairingCode()));
    expect(codes.size).toBeGreaterThan(90);
  });
});

describe('normalizePairingCode', () => {
  it('accepts every way a person might type the code', () => {
    for (const input of ['4820-1937', '48201937', ' 4820 1937 ', '4820.1937']) {
      expect(normalizePairingCode(input), input).toBe('4820-1937');
    }
  });

  it('leaves anything that is not eight digits alone for the lookup to reject', () => {
    expect(normalizePairingCode('12345')).toBe('12345');
  });
});
