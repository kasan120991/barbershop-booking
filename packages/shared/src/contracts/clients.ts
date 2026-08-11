/**
 * Client contracts — and the line between the two halves of them.
 *
 * `ClientDto` is a staff shape. It carries a full name, visit counts and staff notes, and
 * it is returned only behind `requireUser`.
 *
 * `RecogniseClientResponse` is the public shape, and it is one boolean on purpose. The
 * phone number is an unverified identity, so anything that answered "who owns this number?"
 * to an anonymous caller would be a customer directory. The public surfaces send a number
 * **and** a first name and get back only whether the two go together — which is exactly
 * what `/me` was specced to do, and for the same reason.
 *
 * Deliberately absent from the response: the last name. A returning customer does not need
 * it — the server's findOrCreate uses the stored name whatever the form sends — so sending
 * it would leak something for no gain at all.
 */

import { z } from 'zod';

export const clientDtoSchema = z.object({
  id: z.string(),
  phoneE164: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  /** Staff-only, per the schema. Never sent to a public or kiosk surface. */
  notes: z.string().nullable(),
  visitCount: z.int().nonnegative(),
  noShowCount: z.int().nonnegative(),
  lastVisitAt: z.iso.datetime().nullable(),
  /** Surfaced at lookup so the desk finds out before filling the rest of the form in. */
  isBlocked: z.boolean(),
});
export type ClientDto = z.infer<typeof clientDtoSchema>;

export const lookupClientQuerySchema = z.object({
  phone: z.string().min(1, { error: 'Enter a phone number.' }),
});
export type LookupClientQuery = z.infer<typeof lookupClientQuerySchema>;

/**
 * A POST for a read, deliberately.
 *
 * It keeps the number out of the URL — `lib/logger.ts` redacts `*.phoneE164` from bodies,
 * and a query string would walk straight past that into the access log — and it lets the
 * phone-keyed rate limiter read `req.body.phone`, which is how the booking and queue
 * limiters already work.
 */
export const recogniseClientRequestSchema = z.object({
  phone: z.string().min(1),
  firstName: z.string().trim().min(1).max(60),
});
export type RecogniseClientRequest = z.infer<typeof recogniseClientRequestSchema>;

/** One key. Adding a second is a privacy decision, and `clients.test.ts` will say so. */
export const recogniseClientResponseSchema = z.object({
  recognised: z.boolean(),
});
export type RecogniseClientResponse = z.infer<typeof recogniseClientResponseSchema>;
