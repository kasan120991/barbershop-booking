/**
 * The Vapi webhook — one endpoint, every tool.
 *
 * Mounted **inside** `apiRouter`, unlike the Stripe webhook. Stripe sits ahead of
 * `express.json`, `cookieParser` and `authenticate` because its credential is a signature
 * over the raw body, which parsing would destroy. Ours is a header, so it goes through the
 * ordinary stack: `authenticate` resolves the device from `x-device-token`, and `verifyCsrf`
 * exempts it automatically because a device principal is not `kind: 'user'`.
 *
 * Two rules govern everything below, and both come from the fact that a failure here is
 * heard by a person holding a phone:
 *
 * 1. **It answers 200 whenever it answered at all**, even when every tool in the envelope
 *    failed. A non-2xx makes Vapi treat the whole exchange as failed and the caller gets
 *    silence — which is the worst outcome available, and is wrong twice over when one of
 *    two tool calls already committed a booking. Only the auth guard and the rate limiters
 *    refuse outright, because an unauthenticated POST is not a tool result.
 * 2. **Whether an error is spoken or swallowed is decided by `AppError.expose`** — the
 *    same flag the HTTP error handler already uses to decide what a human may see.
 */

import {
  vapiServerMessageSchema,
  VOICE_MESSAGE_TYPE,
  VOICE_TOOL,
  bookAppointmentArgsSchema,
  cancelAppointmentArgsSchema,
  findAppointmentTimesArgsSchema,
  findMyAppointmentsArgsSchema,
  getShopInfoArgsSchema,
  getWalkInWaitArgsSchema,
  listServicesArgsSchema,
  normalizePhone,
  rescheduleAppointmentArgsSchema,
  type VapiToolCall,
  type VapiToolResultEntry,
  type VoiceToolResult,
} from '@francis/shared';
import { Router, type Request, type RequestHandler } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { ZodError, type ZodType } from 'zod';

import { API_PREFIX } from '../config/constants.js';
import { env } from '../config/env.js';
import { isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { limiter } from '../lib/rate-limit.js';
import { requireDevice } from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import { getShopSettings } from '../services/catalog.js';
import {
  bookAppointmentByVoice,
  cancelByVoice,
  composeGreeting,
  findAppointmentTimesForVoice,
  findMyAppointmentsForVoice,
  getShopInfo,
  getWalkInWaitForVoice,
  listServicesForVoice,
  rescheduleByVoice,
  type VoiceCallContext,
} from '../services/voice.js';

export const voiceRouter: Router = Router();

export const VOICE_WEBHOOK_PATH = `${API_PREFIX}/voice/webhook`;

/**
 * The swap point for the auth model.
 *
 * Replacing this with a `requireVapiSecret` comparing `x-vapi-secret` against an env var
 * is the whole change — nothing else in this file knows how the caller was authenticated.
 * Note that a signature-over-raw-body scheme would additionally have to move this route
 * up beside the Stripe webhook, ahead of `express.json`.
 */
const authenticateVapi: RequestHandler = requireDevice('VOICE');

/**
 * Per LINE, keyed on the device.
 *
 * Every delivery arrives from Vapi's egress, so an address key would be one bucket for
 * the world. Keyed on the credential instead, which is also what bounds the damage of a
 * leaked token. Runs FIRST, so a flood is refused before the per-call limiter allocates a
 * bucket for every fabricated call id in it.
 */
const voiceLineLimit = limiter({
  windowMs: 60_000,
  limit: 600,
  message: 'The phone line is busy right now.',
  keyGenerator: (req) => {
    const auth = (req as { auth?: { kind?: string; deviceId?: string } }).auth;
    return auth?.kind === 'device' && auth.deviceId !== undefined
      ? `voice-device:${auth.deviceId}`
      : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
});

/**
 * Per CALL, keyed on Vapi's own call id — the unit that can actually loop.
 *
 * Generous on purpose: this exists for a model stuck in a retry cycle, not for a caller
 * who cannot make their mind up.
 */
const voiceCallLimit = limiter({
  windowMs: 60_000,
  limit: 60,
  message: 'Too many requests on this call.',
  keyGenerator: (req) => {
    const callId = callIdOf(req);
    return callId === null ? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}` : `voice-call:${callId}`;
  },
});

function callIdOf(req: Request): string | null {
  const body = req.body as { message?: { call?: { id?: unknown } } } | undefined;
  const id = body?.message?.call?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

// --- The tool registry -------------------------------------------------------

interface ToolDefinition<T> {
  args: ZodType<T>;
  run: (ctx: VoiceCallContext, args: T) => Promise<VoiceToolResult>;
  /** Whether a redelivery must replay rather than re-run. Reads are safe to repeat. */
  mutates: boolean;
  /** What an audit row should call this, when it writes one. */
  audit?: 'created' | 'rescheduled' | 'cancelled';
}

/**
 * One entry per tool, so adding one is a single line and the JSON schema published to
 * Vapi comes from the same zod schema the server parses with — rather than a hand-copied
 * second definition that drifts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOLS: Record<string, ToolDefinition<any>> = {
  [VOICE_TOOL.GET_SHOP_INFO]: {
    args: getShopInfoArgsSchema,
    run: (ctx) => getShopInfo(ctx),
    mutates: false,
  },
  [VOICE_TOOL.LIST_SERVICES]: {
    args: listServicesArgsSchema,
    run: listServicesForVoice,
    mutates: false,
  },
  [VOICE_TOOL.GET_WALK_IN_WAIT]: {
    args: getWalkInWaitArgsSchema,
    run: getWalkInWaitForVoice,
    mutates: false,
  },
  [VOICE_TOOL.FIND_APPOINTMENT_TIMES]: {
    args: findAppointmentTimesArgsSchema,
    run: findAppointmentTimesForVoice,
    mutates: false,
  },
  [VOICE_TOOL.FIND_MY_APPOINTMENTS]: {
    args: findMyAppointmentsArgsSchema,
    run: (ctx) => findMyAppointmentsForVoice(ctx),
    mutates: false,
  },
  [VOICE_TOOL.BOOK_APPOINTMENT]: {
    args: bookAppointmentArgsSchema,
    run: bookAppointmentByVoice,
    mutates: true,
    audit: 'created',
  },
  [VOICE_TOOL.RESCHEDULE_APPOINTMENT]: {
    args: rescheduleAppointmentArgsSchema,
    run: rescheduleByVoice,
    mutates: true,
    audit: 'rescheduled',
  },
  [VOICE_TOOL.CANCEL_APPOINTMENT]: {
    args: cancelAppointmentArgsSchema,
    run: cancelByVoice,
    mutates: true,
    audit: 'cancelled',
  },
};

// --- Reading the envelope ----------------------------------------------------

/** Vapi puts the name in two different places depending on payload version. */
function toolNameOf(call: VapiToolCall): string | null {
  return call.name ?? call.function?.name ?? null;
}

/** Arguments arrive as an object or as a JSON string, depending on the model. */
function toolArgsOf(call: VapiToolCall): unknown {
  const raw = call.arguments ?? call.function?.arguments;
  if (typeof raw !== 'string') return raw ?? {};

  try {
    return JSON.parse(raw);
  } catch {
    // Malformed JSON from the model is an argument problem, and the per-tool schema
    // below turns it into a question the assistant can ask.
    return {};
  }
}

// --- Turning a thrown error into something a caller hears --------------------

function toErrorEntry(toolCallId: string, error: unknown, requestId: string): VapiToolResultEntry {
  if (error instanceof ZodError) {
    /**
     * Argument validation should TEACH the model, not fail the call — it has to be able
     * to turn round and ask the caller the question it is missing.
     */
    const first = error.issues[0];
    const field = first?.path.join('.') ?? 'that';
    logger.debug({ err: error, requestId }, 'Voice tool arguments rejected');
    return {
      toolCallId,
      result: JSON.stringify({
        say: `I need a bit more before I can do that — check ${field} and ask me again.`,
      } satisfies VoiceToolResult),
    };
  }

  if (isAppError(error) && error.expose && error.status < 500) {
    /**
     * These messages are already sentences written for a customer — "Someone just took
     * that time. Please pick another." Handing one back as `error` would give the model
     * an opaque failure to apologise about generically, and the sentence the service went
     * to the trouble of writing would never be heard by the person it was written for.
     */
    logger.warn({ err: error, requestId }, 'Voice tool refused');
    return { toolCallId, result: JSON.stringify({ say: error.message } satisfies VoiceToolResult) };
  }

  /**
   * A 500, a non-exposed AppError, or something unexpected. `error` is Vapi's failure
   * channel, and the model apologises and offers an alternative rather than reading a
   * stack frame to a customer — the same rule `errorHandler` enforces over HTTP, applied
   * to a different transport.
   */
  logger.error({ err: error, requestId }, 'Voice tool failed');
  return {
    toolCallId,
    error:
      'The booking system did not answer. Apologise once, and offer to take a walk-in or to try again shortly.',
  };
}

// --- Idempotency -------------------------------------------------------------

/**
 * Replays a repeated `toolCall.id` instead of running it twice.
 *
 * Vapi retries on timeout with the SAME id, and a duplicate `book_appointment` is worse
 * than harmless: the second attempt hits the overlap check inside the day lock and comes
 * back "someone just took that time", so the assistant tells the caller their booking
 * failed at the exact moment it succeeded.
 *
 * The ack is `completedAt`, not the row existing — copied from the Stripe webhook — so an
 * attempt that died mid-handler runs again, which is the case retries exist for.
 */
async function runIdempotent(
  call: VapiToolCall,
  name: string,
  ctx: VoiceCallContext,
  run: () => Promise<VapiToolResultEntry>,
): Promise<VapiToolResultEntry> {
  const existing = await prisma.voiceToolCall.findUnique({ where: { toolCallId: call.id } });

  if (existing?.completedAt != null && existing.result !== null) {
    // Verbatim. A caller hearing "you're booked for two fifteen" twice is fine; hearing
    // it once and then a conflict is not.
    return existing.isError
      ? { toolCallId: call.id, error: existing.result }
      : { toolCallId: call.id, result: existing.result };
  }

  const record =
    existing ??
    (await prisma.voiceToolCall
      .create({ data: { toolCallId: call.id, callId: ctx.callId, name } })
      // Two deliveries racing: the loser takes the winner's row rather than failing.
      .catch(() => prisma.voiceToolCall.findUnique({ where: { toolCallId: call.id } })));

  const entry = await run();

  if (record) {
    await prisma.voiceToolCall.update({
      where: { id: record.id },
      data: {
        result: entry.result ?? entry.error ?? '',
        isError: entry.error !== undefined,
        completedAt: new Date(),
      },
    });
  }

  return entry;
}

// --- The endpoint ------------------------------------------------------------

voiceRouter.post('/voice/webhook', voiceLineLimit, voiceCallLimit, authenticateVapi, async (req, res) => {
  const envelope = vapiServerMessageSchema.parse(req.body);
  const message = envelope.message;

  const settings = await getShopSettings();

  /**
   * Resolved ONCE per envelope, not per tool, so every string in one response describes
   * one moment — the same discipline the queue estimator keeps by threading `now` through
   * rather than reading the clock in each branch.
   */
  const ctx: VoiceCallContext = {
    callId: message.call?.id ?? null,
    // From the envelope, never from a tool argument. The docs put it in two places.
    callerPhoneE164: normalizePhone(
      message.call?.customer?.number ??
        message.call?.from?.phoneNumber ??
        message.customer?.number ??
        null,
    ),
    timezone: settings.timezone,
    now: new Date(),
  };

  if (message.type === VOICE_MESSAGE_TYPE.ASSISTANT_REQUEST) {
    await handleAssistantRequest(ctx, res);
    return;
  }

  if (message.type !== VOICE_MESSAGE_TYPE.TOOL_CALLS) {
    // `status-update`, `end-of-call-report`, `speech-update` and whatever Vapi adds next.
    // Acked rather than refused, for the same reason the Stripe webhook 200s an unhandled
    // event type: refusing earns retries forever for something we chose not to handle.
    logger.debug({ type: message.type }, 'Unhandled Vapi message type');
    res.status(200).json({});
    return;
  }

  const calls = message.toolCallList ?? [];
  const results: VapiToolResultEntry[] = [];

  /**
   * Sequential, deliberately. One caller cannot mean two things at once, and two
   * concurrent bookings from a single call would race each other's day lock for nothing.
   */
  for (const call of calls) {
    results.push(await dispatch(req, ctx, call));
  }

  res.status(200).json({ results });
});

async function dispatch(
  req: Request,
  ctx: VoiceCallContext,
  call: VapiToolCall,
): Promise<VapiToolResultEntry> {
  const name = toolNameOf(call);
  const tool = name === null ? undefined : TOOLS[name];

  if (!tool) {
    // A tool we cannot name is one we cannot answer. Spoken rather than errored, so the
    // assistant can move the conversation on instead of apologising for a system fault.
    logger.warn({ name, requestId: req.requestId }, 'Unknown voice tool');
    return {
      toolCallId: call.id,
      result: JSON.stringify({
        say: "I can't do that one. I can book, move or cancel an appointment, or tell you the wait.",
      } satisfies VoiceToolResult),
    };
  }

  const execute = async (): Promise<VapiToolResultEntry> => {
    try {
      const args: unknown = tool.args.parse(toolArgsOf(call));
      const result = await tool.run(ctx, args);

      if (tool.audit) {
        await recordVoiceAudit(req, ctx, call, tool.audit, result);
      }

      return { toolCallId: call.id, result: JSON.stringify(result) };
    } catch (error) {
      return toErrorEntry(call.id, error, req.requestId);
    }
  };

  return tool.mutates ? runIdempotent(call, name ?? 'unknown', ctx, execute) : execute();
}

/**
 * Attributes a voice booking to the device that took it.
 *
 * Reuses the existing appointment actions rather than inventing `voice.*` ones: a booking
 * taken by phone is the same event as a booking taken online, and splitting it would make
 * "every appointment ever created" a union query somebody will get wrong. The channel is
 * already on the row as `Appointment.source = 'VOICE'`.
 *
 * `auditContext(req)` yields `actorDeviceId` for the voice line, and the Vapi call id goes
 * in the payload — so a disputed change leads back to a recording.
 */
async function recordVoiceAudit(
  req: Request,
  ctx: VoiceCallContext,
  call: VapiToolCall,
  kind: 'created' | 'rescheduled' | 'cancelled',
  result: VoiceToolResult,
): Promise<void> {
  const entityId = result.booking?.ref;
  if (kind !== 'cancelled' && entityId === undefined) return;

  const action =
    kind === 'created'
      ? 'appointment.created'
      : kind === 'rescheduled'
        ? 'appointment.rescheduled'
        : 'appointment.cancelled';

  await recordAudit(auditContext(req), {
    action,
    entityType: 'Appointment',
    entityId: entityId ?? 'unknown',
    after: {
      source: 'VOICE',
      vapiCallId: ctx.callId,
      toolCallId: call.id,
      spoken: result.booking?.spoken ?? null,
    },
  });
}

/**
 * The greeting hook.
 *
 * Vapi calls this when the phone number has no `assistantId` bound, which is exactly why
 * the provisioning script sets it to null: it is what lets the assistant open with the
 * caller's name and their existing booking already stated, instead of spending a tool call
 * finding out who is on the line.
 *
 * With `VAPI_ASSISTANT_ID` unset it answers an empty 200, so Vapi falls back to whatever
 * the number is bound to. Missing configuration degrades to "no greeting by name", never
 * to a dropped call.
 */
async function handleAssistantRequest(
  ctx: VoiceCallContext,
  res: Parameters<RequestHandler>[1],
): Promise<void> {
  if (!env.VAPI_ASSISTANT_ID) {
    logger.warn('VAPI_ASSISTANT_ID is not set — answering an assistant-request with no override.');
    res.status(200).json({});
    return;
  }

  const [greeting, settings] = await Promise.all([
    composeGreeting(ctx.callerPhoneE164, ctx.now),
    getShopSettings(),
  ]);

  res.status(200).json({
    assistantId: env.VAPI_ASSISTANT_ID,
    assistantOverrides: {
      firstMessage: greeting.firstMessage,
      variableValues: {
        shopName: settings.name,
        callerFirstName: greeting.firstName ?? '',
        callerKnown: greeting.known ? 'yes' : 'no',
        appointmentSummary: greeting.appointmentSummary ?? '',
        appointmentsOpen: settings.voiceBookingEnabled ? 'yes' : 'no',
        walkInsOpen: settings.walkInQueueEnabled ? 'yes' : 'no',
      },
    },
  });
}
