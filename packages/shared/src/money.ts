/**
 * Money is ALWAYS integer cents, everywhere in this system.
 *
 * Never store, send, or compute with a float dollar amount. Floats lose pennies
 * on arithmetic (0.1 + 0.2 !== 0.3), and a lost penny in a payout is a support
 * ticket. Dollars exist only at the two edges: parsing an admin's typed input,
 * and rendering a string for a human. Both of those live in this file.
 */

/** An integer number of cents. Guaranteed by `assertCents`, not by the type system. */
export type Cents = number;

export const USD = 'USD' as const;

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertCents(value: unknown, label = 'amount'): asserts value is Cents {
  if (!isCents(value)) {
    throw new TypeError(`${label} must be an integer number of cents, received: ${String(value)}`);
  }
}

/**
 * Parse human-typed dollars ("45", "45.5", "$1,234.56") into cents.
 * Returns null on anything unparseable — callers decide whether that is an error.
 */
export function parseDollarsToCents(input: string | number): Cents | null {
  const raw = typeof input === 'number' ? String(input) : input.trim().replace(/[$,\s]/g, '');
  if (raw === '' || !/^-?\d*(\.\d+)?$/.test(raw)) return null;

  const value = Number(raw);
  if (!Number.isFinite(value)) return null;

  // Scale before rounding so 45.955 -> 4596, not 4595.
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Cents -> a plain dollar number. Display and export only — never compute with the result. */
export function centsToDollars(cents: Cents): number {
  assertCents(cents);
  return cents / 100;
}

/** Cents -> a localized currency string, e.g. 4500 -> "$45.00". The only place money is formatted. */
export function formatCents(cents: Cents, currency: string = USD, locale = 'en-US'): string {
  assertCents(cents);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

/** Cents -> a bare amount with no currency symbol, e.g. 4500 -> "45.00". For inputs and CSV. */
export function formatCentsPlain(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function sumCents(amounts: readonly Cents[]): Cents {
  let total = 0;
  for (const amount of amounts) {
    assertCents(amount);
    total += amount;
  }
  return total;
}

/**
 * A percentage of an amount, rounded to the nearest cent — for tip presets and
 * fee previews. Rounds half away from zero so a 15% tip on an odd total does not
 * silently round down in the barber's favour or against it inconsistently.
 */
export function percentOfCents(cents: Cents, percent: number): Cents {
  assertCents(cents);
  if (!Number.isFinite(percent)) {
    throw new TypeError(`percent must be finite, received: ${String(percent)}`);
  }
  const exact = (cents * percent) / 100;
  return exact < 0 ? -Math.round(-exact) : Math.round(exact);
}
