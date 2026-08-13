import { describe, expect, it } from 'vitest';

import {
  assertCents,
  centsToDollars,
  formatCents,
  formatCentsPlain,
  formatCentsSpoken,
  isCents,
  parseDollarsToCents,
  percentOfCents,
  sumCents,
} from './money.js';

describe('isCents', () => {
  it('accepts integers including zero and negatives', () => {
    expect(isCents(0)).toBe(true);
    expect(isCents(4500)).toBe(true);
    expect(isCents(-250)).toBe(true);
  });

  it('rejects the float dollar amounts this system must never carry', () => {
    expect(isCents(45.5)).toBe(false);
    expect(isCents(NaN)).toBe(false);
    expect(isCents(Infinity)).toBe(false);
    expect(isCents('4500')).toBe(false);
    expect(isCents(null)).toBe(false);
  });
});

describe('assertCents', () => {
  it('names the offending value so a bad payload is traceable', () => {
    expect(() => assertCents(45.5, 'tipCents')).toThrow(/tipCents/);
  });
});

describe('parseDollarsToCents', () => {
  it('parses what an admin actually types', () => {
    expect(parseDollarsToCents('45')).toBe(4500);
    expect(parseDollarsToCents('45.00')).toBe(4500);
    expect(parseDollarsToCents('45.5')).toBe(4550);
    expect(parseDollarsToCents('$45.99')).toBe(4599);
    expect(parseDollarsToCents('  $1,234.56 ')).toBe(123456);
    expect(parseDollarsToCents(45.99)).toBe(4599);
  });

  it('scales before rounding so sub-cent input does not truncate downward', () => {
    // 45.955 * 100 is 4595.499... in binary floating point; naive truncation gives 4595.
    expect(parseDollarsToCents('45.955')).toBe(4596);
    expect(parseDollarsToCents('0.005')).toBe(1);
  });

  it('returns null rather than guessing at junk', () => {
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('   ')).toBeNull();
    expect(parseDollarsToCents('abc')).toBeNull();
    expect(parseDollarsToCents('45.00.00')).toBeNull();
    expect(parseDollarsToCents('1e5')).toBeNull();
  });
});

describe('formatCents', () => {
  it('renders USD for display', () => {
    expect(formatCents(4500)).toBe('$45.00');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(-250)).toBe('-$2.50');
  });

  it('refuses to format a float, which would mean cents leaked somewhere upstream', () => {
    expect(() => formatCents(45.5)).toThrow(TypeError);
  });
});

describe('formatCentsPlain', () => {
  it('pads the cents component', () => {
    expect(formatCentsPlain(4500)).toBe('45.00');
    expect(formatCentsPlain(4505)).toBe('45.05');
    expect(formatCentsPlain(5)).toBe('0.05');
    expect(formatCentsPlain(-4505)).toBe('-45.05');
  });
});

describe('centsToDollars', () => {
  it('converts for display only', () => {
    expect(centsToDollars(4500)).toBe(45);
    expect(centsToDollars(4599)).toBe(45.99);
  });
});

describe('sumCents', () => {
  it('adds without floating point drift', () => {
    expect(sumCents([4500, 2000, 1500])).toBe(8000);
    expect(sumCents([])).toBe(0);
    // The classic float failure: 0.1 + 0.2 !== 0.3, but 10 + 20 === 30.
    expect(sumCents([10, 20])).toBe(30);
  });

  it('throws on a non-integer member instead of silently producing a float total', () => {
    expect(() => sumCents([4500, 20.5])).toThrow(TypeError);
  });
});

describe('percentOfCents', () => {
  it('computes tip presets', () => {
    expect(percentOfCents(4500, 20)).toBe(900);
    expect(percentOfCents(4500, 15)).toBe(675);
    expect(percentOfCents(4500, 0)).toBe(0);
  });

  it('rounds to the nearest cent', () => {
    // 15% of $45.55 is 683.25 cents.
    expect(percentOfCents(4555, 15)).toBe(683);
    // 15% of $45.65 is 684.75 cents.
    expect(percentOfCents(4565, 15)).toBe(685);
  });

  it('rounds half away from zero, symmetrically for refunds', () => {
    expect(percentOfCents(1005, 50)).toBe(503);
    expect(percentOfCents(-1005, 50)).toBe(-503);
  });
});

describe('formatCentsSpoken', () => {
  it('drops a trailing .00, which text-to-speech reads as "and zero cents"', () => {
    expect(formatCentsSpoken(4500)).toBe('$45');
    expect(formatCentsSpoken(0)).toBe('$0');
    expect(formatCentsSpoken(123400)).toBe('$1,234');
  });

  it('keeps real cents, because a price with them is not a round number', () => {
    expect(formatCentsSpoken(4550)).toBe('$45.50');
    expect(formatCentsSpoken(123456)).toBe('$1,234.56');
  });

  it('only strips the cents, never digits inside the amount', () => {
    // The regression this guards: a bare `.replace('.00', '')` on "$1,200.00" is fine,
    // but a looser pattern could eat part of the number itself.
    expect(formatCentsSpoken(120000)).toBe('$1,200');
    expect(formatCentsSpoken(-250)).toBe('-$2.50');
    expect(formatCentsSpoken(-20000)).toBe('-$200');
  });

  it('inherits the float guard, so this cannot become a cents-leak escape hatch', () => {
    expect(() => formatCentsSpoken(45.5)).toThrow(TypeError);
  });
});
