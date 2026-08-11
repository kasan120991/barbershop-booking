/**
 * Client DTO mapper.
 *
 * Named fields rather than a spread, like every other mapper here — and it matters more
 * than usual on this one. `Client` is the most personal row in the database, and a column
 * added later must not reach a response because somebody spread the model.
 *
 * This shape is **staff-only**. It carries the full name and the staff notes, and the only
 * route that returns it is behind `requireUser`. Nothing public maps a client at all; the
 * public surfaces get a boolean.
 */

import type { ClientDto } from '@francis/shared';

import type { ClientModel } from '../generated/prisma/models.js';

export function toClientDto(client: ClientModel): ClientDto {
  return {
    id: client.id,
    phoneE164: client.phoneE164,
    firstName: client.firstName,
    lastName: client.lastName,
    notes: client.notes,
    visitCount: client.visitCount,
    noShowCount: client.noShowCount,
    lastVisitAt: client.lastVisitAt?.toISOString() ?? null,
    isBlocked: client.isBlocked,
  };
}
