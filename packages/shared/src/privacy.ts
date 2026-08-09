/**
 * Redaction for screens that face the shop floor.
 *
 * The kiosk and the wall display are visible to every person in the room,
 * including people who are not clients. Anything broadcast to the `kiosk` or
 * `display` socket rooms — and anything rendered on those routes — must go
 * through here first. Full names and full phone numbers never reach that screen.
 *
 * Keeping it in `shared` means the server redacts before it emits AND the
 * frontend cannot accidentally render a field the server did not send.
 */

/** "Darnell" + "Whitaker" -> "Darnell W." — enough to recognize your own name, not someone else's. */
export function publicDisplayName(firstName: string, lastName?: string | null): string {
  const first = firstName.trim();
  const last = lastName?.trim();
  if (!last) return first;
  const initial = [...last][0];
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

/** First name only — for the "now serving" headline where even an initial is more than needed. */
export function firstNameOnly(firstName: string): string {
  return firstName.trim().split(/\s+/)[0] ?? firstName.trim();
}
