/**
 * The walk-in queue contract.
 *
 * Two things are load-bearing here and neither is obvious from the field lists.
 *
 * **There is no `position` in the join request, and no way to set one anywhere.**
 * Order is derived from `(priority DESC, joinedAt ASC)` and computed on read. A
 * position that a client could send — or that the server could store — is a number
 * two requests can disagree about.
 *
 * **The staff shape and the public shape are separate schemas, not one schema with
 * optional fields.** `publicQueueEntryDto` has nowhere to put a phone number, so the
 * kiosk and the wall display cannot render one even by accident. That screen faces
 * the whole shop.
 */

import { z } from 'zod';

import { APPOINTMENT_SOURCE, QUEUE_STATUS } from '../enums.js';

const queueStatus = z.enum(Object.values(QUEUE_STATUS) as [string, ...string[]]);

/** Snapshotted at join time — editing the menu later must not rewrite a waiting client's price. */
export const queueServiceDtoSchema = z.object({
  serviceId: z.string(),
  name: z.string(),
  priceCents: z.int(),
  durationMinutes: z.int(),
});
export type QueueServiceDto = z.infer<typeof queueServiceDtoSchema>;

// --- Joining -----------------------------------------------------------------

export const joinQueueRequestSchema = z.object({
  phone: z.string().min(1, { error: 'Enter a phone number.' }),
  firstName: z.string().trim().min(1, { error: 'Enter a first name.' }).max(60),
  lastName: z.string().trim().max(60).nullish(),
  /** Null or absent means "anyone" — the estimator sends them to whoever frees up first. */
  barberId: z.string().min(1).nullish(),
  serviceIds: z.array(z.string().min(1)).min(1, { error: 'Choose at least one service.' }),
  notes: z.string().trim().max(500).nullish(),
});
export type JoinQueueRequest = z.infer<typeof joinQueueRequestSchema>;

// --- Staff view --------------------------------------------------------------

export const queueEntryDtoSchema = z.object({
  id: z.string(),
  /** 1-based, derived on read. Only meaningful for entries still in the line. */
  position: z.int(),
  status: queueStatus,
  priority: z.int(),

  clientId: z.string(),
  clientName: z.string(),
  clientPhone: z.string(),

  /** What the client asked for. Null means they did not mind. */
  requestedBarberId: z.string().nullable(),
  requestedBarberName: z.string().nullable(),
  /**
   * Which chair the estimator actually put them in. For a client who asked for
   * someone specific these match; for "anyone" this is a projection that can move as
   * the board changes, which is why it is a separate field rather than a mutation.
   */
  assignedBarberId: z.string().nullable(),
  assignedBarberName: z.string().nullable(),

  joinedAt: z.iso.datetime(),
  calledAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  /** When the chair is expected to be ready for them — the seat time, not the finish time. */
  estimatedReadyAt: z.iso.datetime().nullable(),
  estimatedWaitMinutes: z.int().nullable(),
  /** Set when no chair can fit them before closing, so the board can say so. */
  unservableReason: z.string().nullable(),

  durationMinutes: z.int(),
  priceCentsTotal: z.int(),
  services: z.array(queueServiceDtoSchema),
  source: z.enum(Object.values(APPOINTMENT_SOURCE) as [string, ...string[]]),
  notes: z.string().nullable(),
});
export type QueueEntryDto = z.infer<typeof queueEntryDtoSchema>;

export const queueChairDtoSchema = z.object({
  barberId: z.string(),
  displayName: z.string(),
  /** The entry currently in this chair, if any. */
  nowServingEntryId: z.string().nullable(),
  /** When this barber next has time, or null if they are done for the day. */
  freeFrom: z.iso.datetime().nullable(),
  waitingCount: z.int(),
});
export type QueueChairDto = z.infer<typeof queueChairDtoSchema>;

export const queueBoardDtoSchema = z.object({
  generatedAt: z.iso.datetime(),
  /** Mirrors `ShopSettings.walkInQueueEnabled` — the board still renders when off. */
  queueEnabled: z.boolean(),
  chairs: z.array(queueChairDtoSchema),
  entries: z.array(queueEntryDtoSchema),
});
export type QueueBoardDto = z.infer<typeof queueBoardDtoSchema>;

// --- Kiosk and wall display --------------------------------------------------

export const publicQueueEntryDtoSchema = z.object({
  id: z.string(),
  position: z.int(),
  status: queueStatus,
  /** "Darnell W." — enough to recognise your own name, not someone else's. */
  displayName: z.string(),
  barberName: z.string().nullable(),
  estimatedReadyAt: z.iso.datetime().nullable(),
  estimatedWaitMinutes: z.int().nullable(),
});
export type PublicQueueEntryDto = z.infer<typeof publicQueueEntryDtoSchema>;

export const publicQueueBoardDtoSchema = z.object({
  generatedAt: z.iso.datetime(),
  queueEnabled: z.boolean(),
  chairs: z.array(
    z.object({
      barberId: z.string(),
      displayName: z.string(),
      nowServing: z.string().nullable(),
      freeFrom: z.iso.datetime().nullable(),
    }),
  ),
  entries: z.array(publicQueueEntryDtoSchema),
});
export type PublicQueueBoardDto = z.infer<typeof publicQueueBoardDtoSchema>;

// --- Staff actions -----------------------------------------------------------

export const updateQueueStatusRequestSchema = z.object({
  status: queueStatus,
});
export type UpdateQueueStatusRequest = z.infer<typeof updateQueueStatusRequestSchema>;

/**
 * Higher wins. Bounded because it is a nudge, not an ordering scheme — an unbounded
 * integer invites someone to encode a whole hand-made order into it, which is the
 * stored-position problem wearing a different hat.
 */
export const setQueuePriorityRequestSchema = z.object({
  priority: z.int().min(0).max(10),
});
export type SetQueuePriorityRequest = z.infer<typeof setQueuePriorityRequestSchema>;

export const assignQueueBarberRequestSchema = z.object({
  /** Null hands them back to "anyone". */
  barberId: z.string().min(1).nullable(),
});
export type AssignQueueBarberRequest = z.infer<typeof assignQueueBarberRequestSchema>;

export const callNextRequestSchema = z.object({
  barberId: z.string().min(1),
});
export type CallNextRequest = z.infer<typeof callNextRequestSchema>;
