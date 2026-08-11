/**
 * Clients — the people, keyed by the number that identifies them.
 *
 * There are no client accounts. `Client.phoneE164` is unique and it *is* the identity,
 * which is why every one of these functions normalises the number before touching the
 * database: "(415) 555-0123" and "+14155550123" are one person, and letting them become
 * two is the kind of thing nobody notices until somebody's history is split in half.
 *
 * **The identity is unverified**, and that is what shapes `recogniseClient`. Anyone can
 * type anyone's number, so a function that answered "whose number is this?" to the public
 * would be a directory of the shop's customers. It answers a narrower question instead —
 * "do this number and this first name go together?" — which tells a caller nothing they
 * did not already know, and which is the same bargain `/me` was specced to make.
 */

import { normalizePhone } from '@francis/shared';

import type { ClientModel } from '../generated/prisma/models.js';
import { ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export interface ClientNameInput {
  phone: string;
  firstName: string;
  lastName?: string | null | undefined;
}

/**
 * The one place a phone number becomes a client row.
 *
 * This was inlined identically in `booking.ts` and `queue.ts`, differing only in the
 * message for a blocked number — which is the argument.
 *
 * **`update: {}` is deliberate and stays.** A returning client keeps the name they are
 * already on record under; the one typed on a repeat booking is discarded. That used to
 * happen in silence, which is the actual complaint — the desk now sees the stored name
 * before it commits, and the kiosk and the booking site stop asking for a name they were
 * never going to keep.
 */
export async function findOrCreateClient(
  input: ClientNameInput,
  blockedMessage: string,
): Promise<ClientModel> {
  const phoneE164 = normalizePhone(input.phone);
  if (!phoneE164) throw new ValidationError('That phone number does not look right.');

  const client = await prisma.client.upsert({
    where: { phoneE164 },
    update: {},
    create: {
      phoneE164,
      firstName: input.firstName.trim(),
      lastName: input.lastName?.trim() || null,
    },
  });

  if (client.isBlocked) throw new ValidationError(blockedMessage);
  return client;
}

/**
 * Everything the desk is entitled to know about a number. **Staff only.**
 *
 * The route guards this with `requireUser`, which a device token can never satisfy — a
 * kiosk is `{ kind: 'device' }` and has no roles, so the discriminated union refuses it at
 * the type level as well as at runtime.
 */
export function lookupClientByPhone(phone: string): Promise<ClientModel | null> {
  const phoneE164 = normalizePhone(phone);
  if (!phoneE164) return Promise.resolve(null);

  return prisma.client.findUnique({ where: { phoneE164 } });
}

/**
 * Do this number and this first name belong to the same person?
 *
 * A boolean, and nothing else — deliberately not "which person". The caller has to supply
 * the name, so a `true` confirms only what they already believed, and a `false` says
 * nothing about whether the number is known at all. That is the whole privacy design of
 * the public half of this feature, and `clients.test.ts` pins the response shape so a
 * later "helpful" addition of the name has to be a decision rather than an accident.
 *
 * Matched case- and whitespace-insensitively: somebody typing "marcus" at a kiosk is
 * Marcus, and refusing to recognise them would make the feature useless for exactly the
 * people it is for.
 */
export async function recogniseClient(phone: string, firstName: string): Promise<boolean> {
  const phoneE164 = normalizePhone(phone);
  if (!phoneE164) return false;

  const client = await prisma.client.findUnique({
    where: { phoneE164 },
    select: { firstName: true, isBlocked: true },
  });

  // A blocked number is not recognised. Greeting somebody by name and then refusing the
  // booking a moment later is a worse experience than not recognising them.
  if (!client || client.isBlocked) return false;

  return client.firstName.trim().toLocaleLowerCase() === firstName.trim().toLocaleLowerCase();
}
