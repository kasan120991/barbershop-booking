/**
 * The phone receptionist's contract with Vapi.
 *
 * Two halves. The **envelope** is what Vapi POSTs at us, and it is parsed defensively —
 * see below. The **tool arguments** are what the language model fills in, and they are
 * parsed strictly, because a model that invents a field should be told rather than
 * obeyed.
 *
 * Argument names are `snake_case` throughout. That is what Vapi's own tool schemas look
 * like in every example, and it is what models produce most reliably; using the shared
 * schema for both the published JSON schema and the server-side parse means there is no
 * translation layer in between to get it wrong.
 *
 * Nothing here knows about Luxon, Prisma or a timezone. Turning an instant into
 * "Thursday at 2:15" needs `ShopSettings.timezone` and lives in `server/src/mappers`,
 * which is the same boundary that keeps `waitMinutes` out of this package.
 */

import { z } from 'zod';

// --- What Vapi sends us ------------------------------------------------------

/**
 * One tool call.
 *
 * The name arrives at `name` in some payload versions and at `function.name` in others —
 * the docs show both — so both are read and the flat one wins. A tool call we cannot name
 * is a call we cannot answer, and what the caller hears is silence, so this reads
 * defensively rather than strictly.
 *
 * `arguments` is `unknown` because it is an object in some deliveries and a JSON *string*
 * in others, depending on the model. The route normalises it before the strict per-tool
 * schema ever sees it.
 */
export const vapiToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    function: z
      .object({
        name: z.string().min(1).optional(),
        arguments: z.unknown().optional(),
      })
      .loose()
      .optional(),
    arguments: z.unknown().optional(),
  })
  .loose();
export type VapiToolCall = z.infer<typeof vapiToolCallSchema>;

/**
 * The server message envelope.
 *
 * **Every object here is `.loose()`, deliberately.** Vapi adds fields to these payloads,
 * and a strict schema would turn a harmless new key into a 400 — which the caller
 * experiences as the assistant going quiet mid-sentence. We validate what we read and
 * ignore the rest.
 *
 * The caller's number appears at `call.customer.number` on a tool call and at
 * `call.from.phoneNumber` on an assistant request; the docs are not consistent, so both
 * are declared and the server tries them in turn.
 */
export const vapiServerMessageSchema = z
  .object({
    message: z
      .object({
        type: z.string(),
        toolCallList: z.array(vapiToolCallSchema).optional(),
        call: z
          .object({
            id: z.string().optional(),
            customer: z.object({ number: z.string().optional() }).loose().optional(),
            from: z.object({ phoneNumber: z.string().optional() }).loose().optional(),
          })
          .loose()
          .optional(),
        customer: z.object({ number: z.string().optional() }).loose().optional(),
      })
      .loose(),
  })
  .loose();
export type VapiServerMessage = z.infer<typeof vapiServerMessageSchema>;

/** The message types this server does something with. Anything else is acked and ignored. */
export const VOICE_MESSAGE_TYPE = {
  TOOL_CALLS: 'tool-calls',
  ASSISTANT_REQUEST: 'assistant-request',
} as const;

// --- What we send back -------------------------------------------------------

/**
 * One tool's answer, as a JSON string in `result`.
 *
 * `say` is the only field the assistant is meant to voice, and it must contain words —
 * never an id, never an ISO timestamp, never a cent count. `options` and `booking` carry
 * opaque refs the model passes back on the next call without ever reading them aloud.
 */
export const voiceToolResultSchema = z.object({
  /** One or two sentences, sentence case, spoken as written. */
  say: z.string(),
  /** Present when the caller has to choose. The assistant offers by number. */
  options: z
    .array(
      z.object({
        option: z.int(),
        ref: z.string(),
        spoken: z.string(),
      }),
    )
    .optional(),
  /** Present after a successful write, so a follow-up needs no second lookup. */
  booking: z.object({ ref: z.string(), spoken: z.string() }).optional(),
});
export type VoiceToolResult = z.infer<typeof voiceToolResultSchema>;

/**
 * One entry in the response Vapi expects: `{ results: [{ toolCallId, result | error }] }`.
 *
 * `result` is what the assistant works with; `error` is Vapi's failure channel. Which one
 * a thrown error lands in is decided by `AppError.expose` — an exposed 4xx is a decision
 * the shop made and the caller is entitled to hear it, a 500 is a failure the shop had
 * and they must not.
 */
export const vapiToolResultEntrySchema = z.object({
  toolCallId: z.string(),
  result: z.string().optional(),
  error: z.string().optional(),
});
export type VapiToolResultEntry = z.infer<typeof vapiToolResultEntrySchema>;

export const vapiToolResponseSchema = z.object({
  results: z.array(vapiToolResultEntrySchema),
});
export type VapiToolResponse = z.infer<typeof vapiToolResponseSchema>;

// --- Tool arguments ----------------------------------------------------------

/**
 * A spoken day. Resolved server-side against the shop's timezone, because "tomorrow"
 * depends on where the shop is and what time it is there, and the model knows neither.
 */
const spokenDaySchema = z.string().trim().min(1).max(30);

export const VOICE_TOOL = {
  GET_SHOP_INFO: 'get_shop_info',
  LIST_SERVICES: 'list_services',
  GET_WALK_IN_WAIT: 'get_walk_in_wait',
  FIND_APPOINTMENT_TIMES: 'find_appointment_times',
  BOOK_APPOINTMENT: 'book_appointment',
  FIND_MY_APPOINTMENTS: 'find_my_appointments',
  RESCHEDULE_APPOINTMENT: 'reschedule_appointment',
  CANCEL_APPOINTMENT: 'cancel_appointment',
} as const;
export type VoiceTool = (typeof VOICE_TOOL)[keyof typeof VOICE_TOOL];

export const getShopInfoArgsSchema = z.object({}).loose();

export const listServicesArgsSchema = z
  .object({
    /** Narrows the menu when the caller asked for something specific. */
    search: z.string().trim().max(60).nullish(),
  })
  .loose();

export const getWalkInWaitArgsSchema = z
  .object({
    /** Service NAMES as spoken. Omitted quotes the shop's headline wait. */
    services: z.array(z.string().trim().min(1)).nullish(),
    barber: z.string().trim().min(1).max(60).nullish(),
  })
  .loose();

export const findAppointmentTimesArgsSchema = z
  .object({
    services: z.array(z.string().trim().min(1)).nullish(),
    /** Reuses the services already on a booking, for a reschedule. */
    for_appointment_ref: z.string().trim().min(1).nullish(),
    barber: z.string().trim().min(1).max(60).nullish(),
    /** "today", "tomorrow", "saturday", or "2026-08-20". */
    day: spokenDaySchema.nullish(),
    part_of_day: z.enum(['morning', 'afternoon', 'evening']).nullish(),
    /** "after 4", "16:00". */
    after_time: z.string().trim().max(20).nullish(),
  })
  .loose();

export const bookAppointmentArgsSchema = z
  .object({
    /** An opaque ref from `find_appointment_times`. Never a time the model made up. */
    option_ref: z.string().trim().min(1),
    first_name: z.string().trim().min(1).max(60).nullish(),
    last_name: z.string().trim().max(60).nullish(),
    /**
     * Only consulted when the line withheld its number. The envelope's number wins
     * whenever there is one, so the model has no way to book against someone else's.
     */
    phone: z.string().trim().max(30).nullish(),
    notes: z.string().trim().max(500).nullish(),
  })
  .loose();

export const findMyAppointmentsArgsSchema = z.object({}).loose();

export const rescheduleAppointmentArgsSchema = z
  .object({
    appointment_ref: z.string().trim().min(1),
    option_ref: z.string().trim().min(1),
  })
  .loose();

export const cancelAppointmentArgsSchema = z
  .object({
    appointment_ref: z.string().trim().min(1),
    reason: z.string().trim().max(200).nullish(),
  })
  .loose();
