/**
 * The phone number IS the client identity in this system — there are no client
 * accounts and no passwords. So the exact same string has to come out of the
 * kiosk, the public booking form, and the staff app, or the same person becomes
 * three different `Client` rows. Normalization happens here and only here.
 *
 * Scope is deliberately US/NANP: the shop is one location, USD, US phone numbers.
 * If that ever changes, swap this for `libphonenumber-js` rather than growing it.
 */

/** E.164, the storage format: "+" then up to 15 digits. */
const E164 = /^\+[1-9]\d{1,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * Normalize anything a human might type into E.164, or null if it cannot be one.
 *
 * Accepts "555-123-4567", "(555) 123 4567", "15551234567", "+1 555 123 4567".
 * Rejects short, long, and NANP numbers whose area or exchange code starts with
 * 0 or 1 — those are never dialable, and accepting them creates junk client rows.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;

  const trimmed = input.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits === '') return null;

  // Already international and not a NANP number — trust it if it is well-formed.
  if (hadPlus && !digits.startsWith('1')) {
    const candidate = `+${digits}`;
    return isE164(candidate) ? candidate : null;
  }

  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  if (!isDialableNanp(national)) return null;

  return `+1${national}`;
}

function isDialableNanp(national: string): boolean {
  const areaCode = national[0];
  const exchange = national[3];
  if (areaCode === undefined || exchange === undefined) return false;
  return areaCode !== '0' && areaCode !== '1' && exchange !== '0' && exchange !== '1';
}

/** E.164 -> "(555) 123-4567" for staff-facing UI. Non-US numbers pass through unchanged. */
export function formatPhone(e164: string): string {
  if (!e164.startsWith('+1') || e164.length !== 12) return e164;
  const national = e164.slice(2);
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

/**
 * The ten national digits, for seeding a `(999) 999-9999` input mask.
 *
 * A mask fills left to right from whatever it is handed, so feeding it a stored E.164
 * value directly is silently wrong: `+14155550134` becomes `(141) 555-5013` and the
 * next save writes that back. Anything the mask is initialised with has to have the
 * country code taken off first, and this is the only correct way to do it — via
 * `normalizePhone`, so a value that was never a real number seeds an empty field rather
 * than a plausible-looking wrong one.
 *
 * Returns '' for anything non-NANP, including the international numbers `normalizePhone`
 * itself accepts: a ten-digit mask has nowhere to put them.
 */
export function nationalDigits(input: string | null | undefined): string {
  const e164 = normalizePhone(input);
  if (e164 === null || !e164.startsWith('+1') || e164.length !== 12) return '';
  return e164.slice(2);
}

/**
 * "(•••) •••-4567" — last four only.
 *
 * Required anywhere a screen faces the shop floor. See `privacy.ts` for the
 * broader redaction rules; this is the phone-specific piece.
 */
export function redactPhone(e164: string): string {
  const last4 = e164.slice(-4);
  return `(•••) •••-${last4}`;
}
