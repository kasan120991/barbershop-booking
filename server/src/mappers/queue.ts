/**
 * Queue DTO mappers.
 *
 * There are two of these on purpose, and the difference between them is the whole
 * point. `toQueueBoardDto` feeds the staff screen; `toPublicQueueBoardDto` feeds the
 * kiosk and the wall display, which face the room.
 *
 * The public mapper is not the staff one with fields blanked out — it builds a
 * different shape from scratch, so there is nowhere for a phone number, a surname, a
 * price or a staff note to end up. Redacting by omission fails open the day someone
 * adds a field; redacting by construction cannot.
 *
 * The phone number is the one thing the staff board carries that no appointment DTO
 * does. It is there because a walk-in who has drifted to the deli has to be reachable
 * to be called, and it is the reason `/queue` is staff-only.
 */

import {
  publicDisplayName,
  type PublicQueueBoardDto,
  type QueueBoardDto,
  type QueueEntryDto,
  type WalkInQuoteDto,
} from '@francis/shared';

import type { QueueBoard } from '../services/queue.js';

type BoardRow = QueueBoard['entries'][number];

/** Minutes from now until the chair is ready, floored at zero — never a negative wait. */
function waitMinutes(readyAt: Date | null, from: Date): number | null {
  if (readyAt === null) return null;
  return Math.max(0, Math.round((readyAt.getTime() - from.getTime()) / 60_000));
}

function toQueueEntryDto(row: BoardRow, generatedAt: Date): QueueEntryDto {
  const { entry, assignment } = row;
  return {
    id: entry.id,
    position: assignment?.position ?? 0,
    status: entry.status,
    priority: entry.priority,

    clientId: entry.clientId,
    clientName: publicDisplayName(entry.client.firstName, entry.client.lastName),
    clientPhone: entry.client.phoneE164,

    requestedBarberId: entry.barberId,
    requestedBarberName: entry.barber?.displayName ?? null,
    assignedBarberId: assignment?.assignedBarberId ?? null,
    assignedBarberName: row.assignedBarberName,

    joinedAt: entry.joinedAt.toISOString(),
    calledAt: entry.calledAt?.toISOString() ?? null,
    startedAt: entry.startedAt?.toISOString() ?? null,
    estimatedReadyAt: assignment?.estimatedReadyAt?.toISOString() ?? null,
    estimatedWaitMinutes: waitMinutes(assignment?.estimatedReadyAt ?? null, generatedAt),
    unservableReason: assignment?.unservableReason ?? null,

    durationMinutes: entry.durationMinutes,
    priceCentsTotal: entry.priceCentsTotal,
    services: entry.services.map((service) => ({
      serviceId: service.serviceId,
      // The snapshot, not the live menu name.
      name: service.nameSnapshot,
      priceCents: service.priceCents,
      durationMinutes: service.durationMinutes,
    })),
    source: entry.source,
    notes: entry.notes,
  };
}

export function toQueueBoardDto(board: QueueBoard): QueueBoardDto {
  return {
    generatedAt: board.generatedAt.toISOString(),
    queueEnabled: board.queueEnabled,
    chairs: board.chairs.map((chair) => ({
      barberId: chair.barberId,
      displayName: chair.displayName,
      nowServingEntryId: chair.nowServingEntryId,
      nowServingAppointmentId: chair.nowServingAppointmentId,
      freeFrom: chair.freeFrom?.toISOString() ?? null,
      waitingCount: chair.waitingCount,
    })),
    entries: board.entries.map((row) => toQueueEntryDto(row, board.generatedAt)),
  };
}

export function toPublicQueueBoardDto(board: QueueBoard): PublicQueueBoardDto {
  const nowServing = new Map(
    board.entries
      .filter((row) => row.entry.startedAt !== null)
      .map((row) => [row.entry.barberId, row.entry.client.firstName.trim()]),
  );

  /**
   * Called, but not yet sat down. `callNext` attaches them to a chair, so the barber id
   * is on the row — which is what lets the wall board put a name under the right chair
   * without matching on a display name two barbers could share.
   */
  const calledUp = new Map(
    board.entries
      .filter((row) => row.entry.status === 'CALLED')
      .map((row) => [row.entry.barberId, row.entry.client.firstName.trim()]),
  );

  return {
    generatedAt: board.generatedAt.toISOString(),
    queueEnabled: board.queueEnabled,
    /**
     * Through the same `waitMinutes` helper as every other wait on the board, so it is
     * floored at zero and rounded the same way. A screen that said "about -2 min" once
     * would be remembered longer than one that never quotes at all.
     */
    walkUp:
      board.walkUp === null
        ? null
        : {
            availableAt: board.walkUp.availableAt?.toISOString() ?? null,
            waitMinutes: waitMinutes(board.walkUp.availableAt, board.generatedAt),
          },
    chairs: board.chairs.map((chair) => {
      const walkIn = nowServing.get(chair.barberId) ?? null;
      const booked = chair.occupant;

      return {
        barberId: chair.barberId,
        displayName: chair.displayName,
        occupied: walkIn !== null || booked !== null,
        /**
         * First name only in the headline — even an initial is more than the room needs.
         *
         * From either table, and a seated walk-in wins the tie. The board has always
         * named a walk-in in the chair, and nobody in the room can tell which table a
         * person came out of — so naming one and not the other would publish exactly the
         * distinction the shop has no reason to publish.
         */
        nowServing: walkIn ?? booked?.firstName ?? null,
        calledUp: calledUp.get(chair.barberId) ?? null,
        freeFrom: chair.freeFrom?.toISOString() ?? null,
      };
    }),
    entries: board.entries.map((row) => ({
      id: row.entry.id,
      position: row.assignment?.position ?? 0,
      status: row.entry.status,
      displayName: publicDisplayName(row.entry.client.firstName, row.entry.client.lastName),
      barberName: row.assignedBarberName ?? row.entry.barber?.displayName ?? null,
      estimatedReadyAt: row.assignment?.estimatedReadyAt?.toISOString() ?? null,
      estimatedWaitMinutes: waitMinutes(
        row.assignment?.estimatedReadyAt ?? null,
        board.generatedAt,
      ),
    })),
  };
}

/**
 * The kiosk's quote for a basket somebody has actually chosen.
 *
 * Lives here rather than in the route so that every wait in the system goes through the
 * one `waitMinutes` helper above and is floored and rounded identically — a quote that
 * rounded differently from the board would have the same person told two numbers by two
 * screens in the same room.
 *
 * Built from ids alone. There is no name in this shape: the kiosk already holds the
 * roster from `/barbers` and looks each one up, and a second source for a barber's name
 * is a second thing that can disagree with the first.
 */
export function toWalkInQuoteDto(
  board: QueueBoard,
  serviceIds: readonly string[],
  durationMinutes: number,
): WalkInQuoteDto {
  const opening = (availableAt: Date | null) => ({
    availableAt: availableAt?.toISOString() ?? null,
    waitMinutes: waitMinutes(availableAt, board.generatedAt),
  });

  return {
    generatedAt: board.generatedAt.toISOString(),
    serviceIds: [...serviceIds],
    durationMinutes,
    // Null when no chair does the whole set — not the same as every chair being full.
    soonest: board.walkUp === null ? null : opening(board.walkUp.availableAt),
    barbers: (board.walkUp?.byChair ?? []).map((chair) => ({
      barberId: chair.barberId,
      ...opening(chair.availableAt),
    })),
  };
}
