import { describe, expect, it } from 'vitest';

import { formatPhone, isE164, normalizePhone, redactPhone } from './phone.js';

describe('normalizePhone', () => {
  it('collapses every way a human types the same US number into one identity', () => {
    const expected = '+14155550123';
    for (const input of [
      '4155550123',
      '415-555-0123',
      '(415) 555-0123',
      '415.555.0123',
      ' 415 555 0123 ',
      '14155550123',
      '1 (415) 555-0123',
      '+1 415 555 0123',
      '+1-415-555-0123',
    ]) {
      expect(normalizePhone(input), input).toBe(expected);
    }
  });

  it('returns null for empty and missing input', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('rejects wrong-length numbers instead of creating a junk client row', () => {
    expect(normalizePhone('415555')).toBeNull();
    expect(normalizePhone('415555012')).toBeNull();
    expect(normalizePhone('241555501234')).toBeNull();
  });

  it('rejects undialable NANP area and exchange codes', () => {
    // A NANP number is NXX-NXX-XXXX: neither the area code nor the exchange may
    // begin with 0 or 1, so these can never be dialed by a real client.
    expect(normalizePhone('0155550123')).toBeNull();
    expect(normalizePhone('1155550123')).toBeNull();
    expect(normalizePhone('4150555012')).toBeNull();
    expect(normalizePhone('4151550123')).toBeNull();
    expect(normalizePhone('4155550123')).toBe('+14155550123');
  });

  it('rejects 555-123-4567, which looks canonical but is not a valid NANP number', () => {
    // Worth pinning: this is the number everyone reaches for in test data, and its
    // exchange ("123") starts with 1. Rejecting it is correct, not a regression.
    expect(normalizePhone('5551234567')).toBeNull();
  });

  it('passes through well-formed non-NANP numbers that were typed with a +', () => {
    expect(normalizePhone('+442071838750')).toBe('+442071838750');
    expect(normalizePhone('+44 20 7183 8750')).toBe('+442071838750');
  });

  it('does not treat a bare international-length number as international without a +', () => {
    expect(normalizePhone('442071838750')).toBeNull();
  });
});

describe('isE164', () => {
  // Note: this checks storage FORMAT only, deliberately. NANP dialability is
  // enforced once, at the normalization boundary — not on every read.
  it('accepts storage-format numbers', () => {
    expect(isE164('+14155550123')).toBe(true);
    expect(isE164('+442071838750')).toBe(true);
  });

  it('rejects anything not in storage format', () => {
    expect(isE164('14155550123')).toBe(false);
    expect(isE164('(415) 555-0123')).toBe(false);
    expect(isE164('+0415550123')).toBe(false);
    expect(isE164('')).toBe(false);
  });
});

describe('formatPhone', () => {
  it('renders US numbers for staff UI', () => {
    expect(formatPhone('+14155550123')).toBe('(415) 555-0123');
  });

  it('passes non-US numbers through untouched rather than mangling them', () => {
    expect(formatPhone('+442071838750')).toBe('+442071838750');
  });
});

describe('redactPhone', () => {
  it('leaves only the last four for shop-floor screens', () => {
    expect(redactPhone('+14155550187')).toBe('(•••) •••-0187');
  });

  it('never leaks the area code or exchange', () => {
    const redacted = redactPhone('+14155550187');
    expect(redacted).not.toContain('415');
    expect(redacted).not.toContain('555');
  });
});
