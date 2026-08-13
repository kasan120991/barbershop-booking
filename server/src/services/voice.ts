/**
 * The phone receptionist.
 *
 * Plain functions over plain arguments — no `req`, no `res` — per the standing rule, and
 * for the reason that rule exists: this is the fourth client of the same booking path,
 * and it inherits the day lock, the price recomputation and the audit trail rather than
 * reimplementing them. Nothing here writes an appointment; `createAppointment`,
 * `rescheduleAppointment` and `cancelAppointment` still do.
 *
 * Three things are specific to this channel and are what the module actually owns:
 *
 * 1. **Names, not ids.** A caller says "a haircut with Andre", not a cuid. Every spoken
 *    noun is resolved here, and an ambiguous one is refused with a sentence the assistant
 *    can read out.
 * 2. **Refs, not times.** The model hands back an opaque `option_ref` rather than a time
 *    it composed itself, so a booking can only be made against a slot the server actually
 *    offered.
 * 3. **Caller ID is the identity.** The number comes from the call envelope and never
 *    from a tool argument, so the model has no field in which to name somebody else's.
 *
 * Everything a caller hears is built by `mappers/voice.ts`. No raw instant, cent count or
 * id is ever put into a `say` string here.
 */

import { normalizePhone, type VoiceToolResult } from '@francis/shared';
import { DateTime } from 'luxon';

import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import {
  spokenBooking,
  spokenDuration,
  spokenList,
  spokenOffer,
  spokenPrice,
  spokenWait,
  spokenWhen,
} from '../mappers/voice.js';
import { findNextAvailable, type NextAvailableOffer } from './availability.js';
import {
  cancelAppointment,
  createAppointment,
  listUpcomingAppointmentsForClient,
  rescheduleAppointment,
} from './booking.js';
import { getShopHours, getShopSettings, listBarbers, listServices } from './catalog.js';
import { getQueueBoard, quoteWalkIn } from './queue.js';

/**
 * Everything one turn of one call needs, resolved once.
 *
 * `now` and `timezone` are resolved per envelope rather than per tool so that every
 * string in one response describes one moment — the same discipline the queue estimator
 * keeps by threading `now` through instead of reading the clock.
 */
export interface VoiceCallContext {
  callId: string | null;
  /** E.164, or null when the line withheld its number. A first-class state, not an error. */
  callerPhoneE164: string | null;
  timezone: string;
  now: Date;
}

/** The sentence every failed identity lookup gives, whatever actually went wrong. */
const NOT_FOUND_SENTENCE = "I can't find a booking under that number.";

/**
 * The sentence a caller with no number gets.
 *
 * Withholding a number is not an error and not a refusal of service — they can still book
 * something new. It only makes an *existing* booking unreachable, because the number is
 * the only thing tying them to it.
 */
const NO_CALLER_ID_SENTENCE =
  'I can only look that up for the number you booked on. I can take a new booking though.';

// --- Refs --------------------------------------------------------------------

interface OfferRef {
  barberId: string;
  startAt: Date;
  serviceIds: string[];
}

/**
 * A slot offer, encoded so the model can hand it back without ever reading it aloud.
 *
 * **Not a credential, and deliberately not signed.** Everything inside is re-validated by
 * `createAppointment`: the barber must exist and be active, the services are re-priced
 * from their own rows, the notice window applies, and the slot is re-checked for overlap
 * *inside the day lock*. A forged ref can therefore do nothing that `{ barberId, startAt }`
 * as plain arguments could not — which is exactly what the public booking form already
 * posts. Signing it would add a key to rotate in exchange for a property we already have.
 *
 * The time is minutes since the epoch rather than milliseconds: every slot lands on the
 * granularity grid so the precision is spare, and it halves the length of a string a
 * language model has to copy back without a typo.
 */
function encodeOfferRef(offer: OfferRef): string {
  const payload = {
    b: offer.barberId,
    t: Math.floor(offer.startAt.getTime() / 60_000),
    s: offer.serviceIds,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Throws something the assistant can say, never a 500. */
function decodeOfferRef(ref: string): OfferRef {
  try {
    const raw: unknown = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
    const parsed = raw as { b?: unknown; t?: unknown; s?: unknown };

    if (
      typeof parsed.b !== 'string' ||
      typeof parsed.t !== 'number' ||
      !Array.isArray(parsed.s) ||
      !parsed.s.every((id): id is string => typeof id === 'string')
    ) {
      throw new Error('shape');
    }

    return { barberId: parsed.b, startAt: new Date(parsed.t * 60_000), serviceIds: parsed.s };
  } catch {
    // A truncated or garbled ref means the model mangled it. Asking again is the only
    // useful recovery, and it is something the assistant can actually say.
    throw new ValidationError('Let me check those times again.');
  }
}

// --- Resolving what a caller said --------------------------------------------

/**
 * Spoken service names to rows.
 *
 * Exact match first, then a unique substring — "beard" finds "Beard Trim", but only while
 * there is exactly one. Several matches is a question for the caller, not a guess, and the
 * error lists them so the assistant can ask it.
 */
async function resolveServiceNames(names: readonly string[]) {
  const menu = await listServices({ includeArchived: false });
  const resolved: typeof menu = [];

  for (const spoken of names) {
    const needle = spoken.trim().toLocaleLowerCase();
    if (needle.length === 0) continue;

    const exact = menu.filter((service) => service.name.toLocaleLowerCase() === needle);
    const partial =
      exact.length > 0
        ? exact
        : menu.filter((service) => service.name.toLocaleLowerCase().includes(needle));

    if (partial.length === 0) {
      throw new ValidationError(
        `I don't have "${spoken}" on the menu. We do ${spokenList(menu.map((service) => service.name))}.`,
      );
    }
    if (partial.length > 1) {
      throw new ValidationError(
        `Did you mean ${spokenList(partial.map((service) => service.name))}?`,
      );
    }

    const match = partial[0];
    if (match && !resolved.some((service) => service.id === match.id)) resolved.push(match);
  }

  if (resolved.length === 0) throw new ValidationError('What were you after — a cut, a beard trim?');
  return resolved;
}

/** Same rules as the service names, applied to the roster. */
async function resolveBarberName(spoken: string) {
  const roster = await listBarbers({ includeInactive: false });
  const needle = spoken.trim().toLocaleLowerCase();

  const exact = roster.filter((barber) => barber.displayName.toLocaleLowerCase() === needle);
  const partial =
    exact.length > 0
      ? exact
      : roster.filter((barber) => barber.displayName.toLocaleLowerCase().includes(needle));

  if (partial.length === 0) {
    throw new ValidationError(
      `I don't have a barber called ${spoken}. We have ${spokenList(roster.map((barber) => barber.displayName))}.`,
    );
  }
  if (partial.length > 1) {
    throw new ValidationError(
      `Did you mean ${spokenList(partial.map((barber) => barber.displayName))}?`,
    );
  }

  return partial[0];
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/**
 * "tomorrow", "saturday", "2026-08-20" to a local shop date.
 *
 * Resolved here rather than by the model because "tomorrow" depends on where the shop is
 * and what time it is there, and the model knows neither — it is told the local date in
 * its prompt, but a call that runs past midnight would still drift.
 *
 * A weekday name always means the NEXT one: somebody phoning on Tuesday asking for
 * Tuesday means next week, not five minutes ago.
 */
function resolveSpokenDay(spoken: string, timezone: string, now: Date): string {
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day');
  const needle = spoken.trim().toLocaleLowerCase();

  if (/^\d{4}-\d{2}-\d{2}$/.test(needle)) {
    const parsed = DateTime.fromISO(needle, { zone: timezone });
    if (!parsed.isValid) throw new ValidationError('What day were you thinking?');
    return needle;
  }

  if (needle === 'today' || needle === 'now') return today.toFormat('yyyy-MM-dd');
  if (needle === 'tomorrow') return today.plus({ days: 1 }).toFormat('yyyy-MM-dd');

  const weekdayIndex = WEEKDAYS.findIndex((day) => needle.includes(day));
  if (weekdayIndex >= 0) {
    // Luxon weekday is Monday=1..Sunday=7; the array is Sunday=0..Saturday=6.
    const todayIndex = today.weekday % 7;
    const ahead = (weekdayIndex - todayIndex + 7) % 7 || 7;
    return today.plus({ days: ahead }).toFormat('yyyy-MM-dd');
  }

  throw new ValidationError('What day were you thinking?');
}

/** Local hour that a part of the day begins at, for narrowing a search. */
const PART_OF_DAY_HOUR: Record<string, number> = { morning: 0, afternoon: 12, evening: 17 };

/** "after 4", "4pm", "16:00" to a local hour. Returns null when it means nothing. */
function parseSpokenHour(spoken: string): number | null {
  const match = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(spoken.trim());
  if (!match) return null;

  let hour = Number(match[1]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;

  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  // Bare small numbers on a barbershop's phone mean the afternoon: nobody rings up
  // asking for "after four" and means four in the morning.
  if (!meridiem && hour < 8) hour += 12;

  return hour;
}

function resolveAfter(
  date: string,
  timezone: string,
  partOfDay: string | null | undefined,
  afterTime: string | null | undefined,
): Date | undefined {
  const hour =
    (afterTime ? parseSpokenHour(afterTime) : null) ??
    (partOfDay ? (PART_OF_DAY_HOUR[partOfDay] ?? null) : null);

  if (hour === null || hour <= 0) return undefined;

  const at = DateTime.fromISO(date, { zone: timezone }).startOf('day').set({ hour });
  return at.isValid ? at.toUTC().toJSDate() : undefined;
}

// --- Who is calling ----------------------------------------------------------

/** The client row behind the calling number, or null. Blocked numbers read as unknown. */
async function resolveCaller(phoneE164: string | null) {
  if (!phoneE164) return null;
  const client = await prisma.client.findUnique({ where: { phoneE164 } });
  if (!client || client.isBlocked) return null;
  return client;
}

export interface VoiceGreeting {
  known: boolean;
  firstName: string | null;
  /** Non-null when they have something coming up, already in spoken words. */
  appointmentSummary: string | null;
  firstMessage: string;
}

/**
 * What the assistant opens the call with.
 *
 * A known caller is greeted by first name and told what they already have booked, so the
 * common call — "I need to move Thursday" — starts at the point instead of spending two
 * turns getting there.
 *
 * This is the one place the system volunteers a name for a phone number, which
 * `recogniseClient` exists specifically to avoid doing. It is a deliberate, blessed
 * exception for this channel: caller ID is spoofable, so what it buys is convenience and
 * what it costs is that someone spoofing the number learns a first name and a haircut
 * time. Bounded accordingly — **first name only, never a surname, never history, never
 * notes**, and a blocked client is greeted as a stranger.
 */
export async function composeGreeting(
  phoneE164: string | null,
  now: Date,
): Promise<VoiceGreeting> {
  const [settings, client] = await Promise.all([getShopSettings(), resolveCaller(phoneE164)]);
  const shopName = settings.name;

  if (!client) {
    return {
      known: false,
      firstName: null,
      appointmentSummary: null,
      firstMessage: `Thanks for calling ${shopName}. How can I help?`,
    };
  }

  const upcoming = await listUpcomingAppointmentsForClient(client.id, now, 1);
  const next = upcoming[0];
  const firstName = client.firstName;

  if (!next) {
    return {
      known: true,
      firstName,
      appointmentSummary: null,
      firstMessage: `Hi ${firstName}, thanks for calling ${shopName}. How can I help?`,
    };
  }

  const summary = `${spokenWhen(next.startAt, settings.timezone, now)} with ${next.barber.displayName}`;

  return {
    known: true,
    firstName,
    appointmentSummary: summary,
    firstMessage:
      `Hi ${firstName}, thanks for calling ${shopName}. ` +
      `I've got you down ${summary}. Did you want to reschedule that, cancel it, or was it something else?`,
  };
}

/**
 * Loads the caller's upcoming bookings and turns them into numbered options.
 *
 * The ref is the appointment id, NOT the cancel token. The token is a never-expiring
 * bearer credential handed out exactly once, and putting it into a third party's stored
 * call transcripts widens its exposure permanently. An id is not a credential — the
 * mutation is authorised by the calling number instead, in `assertCallerOwns`.
 */
async function callerAppointments(ctx: VoiceCallContext) {
  const client = await resolveCaller(ctx.callerPhoneE164);
  if (!client) return [];
  return listUpcomingAppointmentsForClient(client.id, ctx.now, 5);
}

/**
 * Whether the caller may act on this appointment.
 *
 * A wrong ref, an appointment belonging to somebody else, and a withheld number all give
 * the SAME sentence, so the tool cannot be walked to find out whether a given booking
 * exists.
 */
async function assertCallerOwns(ctx: VoiceCallContext, appointmentId: string) {
  if (!ctx.callerPhoneE164) throw new NotFoundError(NO_CALLER_ID_SENTENCE);

  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { services: true, client: true, barber: true },
  });

  if (!appointment || appointment.client.phoneE164 !== ctx.callerPhoneE164) {
    throw new NotFoundError(NOT_FOUND_SENTENCE);
  }

  return appointment;
}

// --- Tools -------------------------------------------------------------------

export async function getShopInfo(ctx: VoiceCallContext): Promise<VoiceToolResult> {
  const hours = await getShopHours();

  const today = DateTime.fromJSDate(ctx.now).setZone(ctx.timezone);
  const line = (at: DateTime, label: string) => {
    const row = hours.find((entry) => entry.dayOfWeek === at.weekday % 7);
    if (!row || row.isClosed) return `we're closed ${label}`;
    const open = at.startOf('day').set({ hour: Math.floor(row.openMinute / 60), minute: row.openMinute % 60 });
    const close = at.startOf('day').set({ hour: Math.floor(row.closeMinute / 60), minute: row.closeMinute % 60 });
    return `${label} we're open ${open.toFormat('h:mm a')} to ${close.toFormat('h:mm a')}`;
  };

  return {
    say:
      `${line(today, 'Today')}, and ${line(today.plus({ days: 1 }), 'tomorrow')}. ` +
      'We take walk-ins as well as appointments, and you pay after your cut — card or cash. ' +
      "There's no deposit.",
  };
}

export async function listServicesForVoice(
  _ctx: VoiceCallContext,
  args: { search?: string | null },
): Promise<VoiceToolResult> {
  const menu = await listServices({ includeArchived: false });
  const needle = args.search?.trim().toLocaleLowerCase();

  const matching = needle
    ? menu.filter((service) => service.name.toLocaleLowerCase().includes(needle))
    : menu;

  if (matching.length === 0) {
    return {
      say: `I don't have that one. We do ${spokenList(menu.map((service) => service.name))}.`,
    };
  }

  // Capped, because a menu read past about eight items stops being information.
  const spoken = matching
    .slice(0, 8)
    .map(
      (service) =>
        `${service.name}, ${spokenPrice(service.priceCents)}, ${spokenDuration(service.durationMinutes)}`,
    );

  const more = matching.length > 8 ? ' And a few more — was there something specific?' : '';

  return { say: `We do ${spokenList(spoken)}.${more}` };
}

export async function getWalkInWaitForVoice(
  ctx: VoiceCallContext,
  args: { services?: string[] | null; barber?: string | null },
): Promise<VoiceToolResult> {
  const settings = await getShopSettings();

  if (!settings.walkInQueueEnabled) {
    return { say: "We're not taking walk-ins right now, but I can book you a time." };
  }

  const services = args.services?.length ? await resolveServiceNames(args.services) : [];

  /**
   * No named service is a different question, not an empty one.
   *
   * `quoteWalkIn` prices a specific basket and refuses an empty one. "How busy are you?"
   * has no basket, and the board already answers it with its own default probe — the
   * shortest walk-in-able service, which is the same headline number the kiosk and the
   * wall display show. Asking `quoteWalkIn([])` instead just threw "Choose at least one
   * service" at somebody who had not been asked to choose anything.
   */
  const board =
    services.length === 0
      ? await getQueueBoard({ now: ctx.now })
      : (await quoteWalkIn(services.map((service) => service.id), ctx.now)).board;

  const walkUp = board.walkUp;

  if (!walkUp || walkUp.availableAt === null) {
    return {
      say: "Nobody in today can fit that in as a walk-in, but I can book you a time. Shall I look?",
    };
  }

  const minutesFrom = (at: Date | null) =>
    at === null ? null : Math.max(0, Math.round((at.getTime() - board.generatedAt.getTime()) / 60_000));

  if (args.barber) {
    const barber = await resolveBarberName(args.barber);
    const chair = walkUp.byChair.find((entry) => entry.barberId === barber?.id);
    return {
      say: chair
        ? `For ${barber?.displayName ?? 'them'}, it's ${spokenWait(minutesFrom(chair.availableAt))}.`
        : `${barber?.displayName ?? 'They'} can't fit that in today, but I can book you a time.`,
    };
  }

  const chairs = await listBarbers({ includeInactive: false });
  const nameById = new Map(chairs.map((barber) => [barber.id, barber.displayName]));

  const named = walkUp.byChair
    .filter((chair) => chair.availableAt !== null)
    .slice(0, 3)
    .map((chair) => `${nameById.get(chair.barberId) ?? 'someone'} is ${spokenWait(minutesFrom(chair.availableAt))}`);

  return {
    say: `The shortest wait right now is ${spokenWait(minutesFrom(walkUp.availableAt))}. ${
      named.length > 0 ? `${spokenList(named)}.` : ''
    }`.trim(),
  };
}

export async function findAppointmentTimesForVoice(
  ctx: VoiceCallContext,
  args: {
    services?: string[] | null;
    for_appointment_ref?: string | null;
    barber?: string | null;
    day?: string | null;
    part_of_day?: string | null;
    after_time?: string | null;
  },
): Promise<VoiceToolResult> {
  /**
   * A reschedule reuses the services already on the booking rather than asking again.
   * That is not a shortcut — it is what keeps the snapshotted price intact through the
   * move, because `rescheduleAppointment` only re-snapshots when the basket changes.
   */
  let serviceIds: string[];
  if (args.for_appointment_ref) {
    const existing = await assertCallerOwns(ctx, args.for_appointment_ref);
    serviceIds = existing.services.map((service) => service.serviceId);
  } else {
    const services = await resolveServiceNames(args.services ?? []);
    serviceIds = services.map((service) => service.id);
  }

  const barber = args.barber ? await resolveBarberName(args.barber) : null;
  const fromDate = args.day ? resolveSpokenDay(args.day, ctx.timezone, ctx.now) : undefined;
  const after = fromDate ? resolveAfter(fromDate, ctx.timezone, args.part_of_day, args.after_time) : undefined;

  const result = await findNextAvailable({
    serviceIds,
    ...(barber ? { barberId: barber.id } : {}),
    ...(fromDate ? { fromDate } : {}),
    ...(after ? { after } : {}),
    limit: 3,
    // The phone is not the internet — see `voiceBookingEnabled`.
    enforceOnlineRules: false,
    now: ctx.now,
  });

  if (result.offers.length === 0) {
    return { say: `${result.reason ?? 'I could not find anything.'} Shall I look further ahead?` };
  }

  const options = result.offers.map((offer: NextAvailableOffer, index) => ({
    option: index + 1,
    ref: encodeOfferRef({ barberId: offer.barberId, startAt: offer.startAt, serviceIds }),
    spoken: spokenOffer(offer, ctx.timezone, ctx.now),
  }));

  return {
    say: `I've got ${spokenList(options.map((option) => option.spoken))}. Which works?`,
    options,
  };
}

export async function bookAppointmentByVoice(
  ctx: VoiceCallContext,
  args: {
    option_ref: string;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    notes?: string | null;
  },
): Promise<VoiceToolResult> {
  const settings = await getShopSettings();

  /**
   * The phone line's own switch. Not `onlineBookingEnabled` — that one governs the
   * website, and its own error message tells people to call the shop, which is what this
   * caller is doing.
   */
  if (!settings.voiceBookingEnabled) {
    throw new ConflictError(
      "I can't book over the phone at the moment. You're welcome to walk in, or book on the website.",
    );
  }

  const offer = decodeOfferRef(args.option_ref);

  /**
   * The envelope's number always wins. A spoken one is consulted only when the line
   * withheld its own, which is the same unverified-identity bargain the booking site
   * already runs on — but it means the model can never be talked into booking against
   * somebody else's number, because the field is ignored whenever caller ID exists.
   */
  const phone = ctx.callerPhoneE164 ?? normalizePhone(args.phone ?? null);
  if (!phone) {
    throw new ValidationError('What number should I put the booking under?');
  }

  const existing = await resolveCaller(phone);
  const firstName = args.first_name?.trim() || existing?.firstName;
  if (!firstName) throw new ValidationError('Can I take your first name?');

  /**
   * The model asking twice, with a fresh `toolCallId` each time.
   *
   * The route's idempotency covers Vapi redelivering the same call; this covers the model
   * simply repeating itself. Without it the second attempt hits the day lock and comes
   * back "someone just took that time", and the assistant tells the caller their booking
   * failed at the exact moment it succeeded.
   */
  if (existing) {
    const already = await prisma.appointment.findFirst({
      where: {
        clientId: existing.id,
        barberId: offer.barberId,
        startAt: offer.startAt,
        status: { in: ['BOOKED', 'IN_PROGRESS'] },
      },
      include: { services: true, client: true, barber: true },
    });

    if (already) {
      return {
        say: `You're already down for ${spokenWhen(already.startAt, ctx.timezone, ctx.now)} with ${already.barber.displayName}.`,
        booking: {
          ref: already.id,
          spoken: spokenWhen(already.startAt, ctx.timezone, ctx.now),
        },
      };
    }
  }

  const appointment = await createAppointment({
    barberId: offer.barberId,
    serviceIds: offer.serviceIds,
    startAt: offer.startAt,
    client: { phone, firstName, lastName: args.last_name ?? null },
    source: 'VOICE',
    notes: args.notes ?? null,
    // A phone caller is the public: they are not standing in the shop and the barber has
    // not seen them, so the notice window applies.
    enforceMinimumNotice: true,
    // But the shop's *online* switches do not — see `voiceBookingEnabled` above.
    enforceOnlineRules: false,
    now: ctx.now,
  });

  const spoken = spokenBooking(
    {
      startAt: appointment.startAt,
      barberName: appointment.barber.displayName,
      serviceNames: appointment.services.map((service) => service.nameSnapshot),
      durationMinutes: appointment.durationMinutes,
      priceCentsTotal: appointment.priceCentsTotal,
    },
    ctx.timezone,
    ctx.now,
  );

  return {
    say: `You're booked, ${firstName} — ${spoken}. You pay after, card or cash.`,
    booking: { ref: appointment.id, spoken },
  };
}

export async function findMyAppointmentsForVoice(
  ctx: VoiceCallContext,
): Promise<VoiceToolResult> {
  if (!ctx.callerPhoneE164) return { say: NO_CALLER_ID_SENTENCE };

  const appointments = await callerAppointments(ctx);
  if (appointments.length === 0) return { say: NOT_FOUND_SENTENCE };

  const options = appointments.map((appointment, index) => ({
    option: index + 1,
    ref: appointment.id,
    spoken: `${spokenWhen(appointment.startAt, ctx.timezone, ctx.now)} with ${appointment.barber.displayName}`,
  }));

  return {
    say: `I've got you down for ${spokenList(options.map((option) => option.spoken))}.`,
    options,
  };
}

export async function rescheduleByVoice(
  ctx: VoiceCallContext,
  args: { appointment_ref: string; option_ref: string },
): Promise<VoiceToolResult> {
  const settings = await getShopSettings();
  if (!settings.voiceBookingEnabled) {
    throw new ConflictError("I can't change bookings over the phone at the moment.");
  }

  await assertCallerOwns(ctx, args.appointment_ref);
  const offer = decodeOfferRef(args.option_ref);

  const moved = await rescheduleAppointment({
    appointmentId: args.appointment_ref,
    startAt: offer.startAt,
    barberId: offer.barberId,
    // Services deliberately omitted, so the snapshotted price survives the move.
    enforceMinimumNotice: true,
    enforceOnlineRules: false,
    now: ctx.now,
  });

  const spoken = `${spokenWhen(moved.startAt, ctx.timezone, ctx.now)} with ${moved.barber.displayName}`;

  return {
    say: `Moved — ${spoken} instead. Same ${spokenList(moved.services.map((service) => service.nameSnapshot))}, ${spokenPrice(moved.priceCentsTotal)}.`,
    booking: { ref: moved.id, spoken },
  };
}

export async function cancelByVoice(
  ctx: VoiceCallContext,
  args: { appointment_ref: string; reason?: string | null },
): Promise<VoiceToolResult> {
  const appointment = await assertCallerOwns(ctx, args.appointment_ref);
  const spoken = `${spokenWhen(appointment.startAt, ctx.timezone, ctx.now)} with ${appointment.barber.displayName}`;

  await cancelAppointment(appointment.id, {
    reason: args.reason ?? 'Cancelled by phone',
    // The same window the online cancel link respects. A caller inside it is told to
    // speak to the shop, which — given they are on the phone to it — the assistant
    // handles by offering to take a message.
    enforceMinimumNotice: true,
    now: ctx.now,
  });

  return { say: `That's cancelled — ${spoken}. Anything else?` };
}

/** Exported for the tests that pin the ref round-trip. */
export const __testing = { encodeOfferRef, decodeOfferRef, resolveSpokenDay, parseSpokenHour };
