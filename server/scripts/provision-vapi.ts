/**
 * Creates or updates the phone receptionist in Vapi.
 *
 *   pnpm --filter @francis/server vapi:provision -- --token <voice device token>
 *
 * Idempotent, and matched on an exact `[francis-cutz]` name prefix. **That prefix is a
 * safety mechanism, not tidiness:** the Vapi account is shared with other work, and a
 * create-or-update matched loosely on name would reconfigure or overwrite a live phone
 * line belonging to something else. Nothing without the prefix is ever touched.
 *
 * It reads the shop's own database for the roster and the menu, and feeds both to the
 * transcriber as keyterms. Without that, "Dre" comes back as "dray" and a service called
 * "Skin Fade" comes back as "skin faded" — and the caller then hears the assistant claim
 * it has never heard of the barber they asked for by name.
 */

import type { Vapi } from '@vapi-ai/server-sdk';
import { DateTime } from 'luxon';

import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { vapi } from '../src/lib/vapi.js';

const PREFIX = '[francis-cutz]';
const ASSISTANT_NAME = `${PREFIX} Receptionist`;
const PHONE_NUMBER_NAME = `${PREFIX} Receptionist`;

/** Only ever act on our own resources. Anything else in the account is somebody's live line. */
const ours = (name: string | undefined): boolean => (name ?? '').startsWith(PREFIX);

function requireServerUrl(): string {
  if (!env.VAPI_SERVER_URL) {
    throw new Error(
      'VAPI_SERVER_URL is not set. Point it at a public origin Vapi can reach — in ' +
        'development that means a tunnel, e.g. `cloudflared tunnel --url http://localhost:4000`.',
    );
  }
  return `${env.VAPI_SERVER_URL.replace(/\/$/, '')}/api/voice/webhook`;
}

/** The voice line's device token, issued once from Screens & Devices. */
function requireDeviceToken(): string {
  const flag = process.argv.indexOf('--token');
  const fromArgv = flag >= 0 ? process.argv[flag + 1] : undefined;
  const token = fromArgv ?? process.env.VOICE_DEVICE_TOKEN;

  if (!token) {
    throw new Error(
      'No voice device token. Issue one in the staff app under Screens & Devices ' +
        '(type: Phone Line), then pass it as `--token <token>` or set VOICE_DEVICE_TOKEN.\n' +
        'It is deliberately not in .env: it is a database row, so revoking it is one click ' +
        'rather than a redeploy.',
    );
  }
  return token;
}

// --- The tools ---------------------------------------------------------------

interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, Vapi.JsonSchema>;
  required?: string[];
}

/**
 * Descriptions are written for the model, not for a developer.
 *
 * Each one says when to reach for the tool and, where it matters, what NOT to do with it —
 * the model's biggest failure mode is inventing an argument rather than calling the tool
 * that would have given it one.
 */
const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'get_shop_info',
    description:
      "Today's and tomorrow's opening hours, and how payment works. Call this whenever " +
      'someone asks when the shop is open, where it is, or how they pay. Never answer ' +
      'those from memory.',
    properties: {},
  },
  {
    name: 'list_services',
    description:
      'The service menu with prices and how long each takes. Call this before quoting any ' +
      'price or duration. You do not know the prices otherwise.',
    properties: {
      search: {
        type: 'string',
        description: 'Optional. Narrows the menu when the caller named something specific.',
      },
    },
  },
  {
    name: 'get_walk_in_wait',
    description:
      'The live walk-in wait, per barber. Call this when someone asks how busy it is or ' +
      'how long the wait is. You cannot put anyone in the walk-in line — it is for people ' +
      'in the shop — so quote the wait and offer to book a time instead.',
    properties: {
      services: {
        type: 'array',
        items: { type: 'string' },
        description: 'Service names as the caller said them. Omit for the general wait.',
      },
      barber: { type: 'string', description: "A barber's name, if they asked for one." },
    },
  },
  {
    name: 'find_appointment_times',
    description:
      'Finds bookable times. Call this before offering any time — never suggest one ' +
      'yourself. It returns numbered options; read them out and let the caller pick one. ' +
      'For a reschedule, pass for_appointment_ref instead of services so the booking keeps ' +
      'the price it was made at.',
    properties: {
      services: {
        type: 'array',
        items: { type: 'string' },
        description: 'Service names as the caller said them.',
      },
      for_appointment_ref: {
        type: 'string',
        description: 'A ref from find_my_appointments, to reuse that booking’s services.',
      },
      barber: { type: 'string', description: 'A barber’s name. Omit for anyone.' },
      day: { type: 'string', description: '"today", "tomorrow", a weekday, or YYYY-MM-DD.' },
      part_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening'] },
      after_time: { type: 'string', description: 'e.g. "after 4" or "16:00".' },
    },
  },
  {
    name: 'book_appointment',
    description:
      'Books one of the times you just offered. option_ref must be copied exactly from ' +
      'find_appointment_times — never make one up. Afterwards, read the confirmation back: ' +
      'day, time, barber, service, and price.',
    properties: {
      option_ref: { type: 'string', description: 'Copied exactly from find_appointment_times.' },
      first_name: { type: 'string', description: 'Ask for it if you do not have it yet.' },
      last_name: { type: 'string' },
      phone: {
        type: 'string',
        description:
          'Only if the caller withheld their number. Otherwise leave this out — the number ' +
          'they are calling from is used automatically.',
      },
      notes: { type: 'string', description: 'Anything they asked you to pass on.' },
    },
    required: ['option_ref'],
  },
  {
    name: 'find_my_appointments',
    description:
      'What the caller already has booked, using the number they are calling from. Call ' +
      'this before rescheduling or cancelling, so you know which booking they mean.',
    properties: {},
  },
  {
    name: 'reschedule_appointment',
    description:
      'Moves an existing booking. Needs a ref from find_my_appointments and a time from ' +
      'find_appointment_times. Read the new day, time and barber back afterwards.',
    properties: {
      appointment_ref: { type: 'string' },
      option_ref: { type: 'string' },
    },
    required: ['appointment_ref', 'option_ref'],
  },
  {
    name: 'cancel_appointment',
    description:
      'Cancels a booking. Read the day, time and barber back to the caller BEFORE you ' +
      'call this, and only cancel the one they named.',
    properties: {
      appointment_ref: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['appointment_ref'],
  },
];

// --- The prompt --------------------------------------------------------------

function systemPrompt(shopName: string, barbers: string[], todayLocal: string): string {
  return `You are the receptionist at ${shopName}, a barbershop with one location. You are
answering the phone. You are warm, brief and efficient — the way a good front desk is when
the shop is busy.

Today is ${todayLocal}.
The barbers are ${barbers.join(', ')}.
{% if callerKnown == "yes" %}The number calling belongs to {{callerFirstName}}, so greet them
by that name.{% endif %}
{% if appointmentSummary != "" %}They already have a booking: {{appointmentSummary}}. Offer to
reschedule or cancel it before assuming they want something new.{% endif %}

HOW YOU TALK
- Short sentences. One question at a time. Never list more than three things.
- Say times the way a person does: "two fifteen", "half past ten", "Thursday morning".
- Contractions, always. "I've got" not "I have got". "That's booked" not "That is booked".
- Never read out a code, a reference, an ID, or a date as numbers like 2026-08-14.
- Do not say "as an AI", do not explain how you work, and do not mention tools or systems.
  You are the shop's receptionist.
- If you did not catch something, ask them to say it again. Never guess a name or a time.
- When you need a moment, say so naturally — "let me have a look" — then call the tool.

WHAT YOU KNOW
- You never invent a price, a time, a barber's name, a service or a wait. Every one of
  those comes from a tool. If a tool has not told you, you do not know it yet — go and ask.
- If a tool fails, say the booking system is not answering right now, apologise once, and
  offer either to have them try again shortly or to come in as a walk-in. Never promise
  that somebody will call them back.

THE SHOP
- One location. Prices are in US dollars.
- Payment is AFTER the cut, in the shop — card or cash. There is no deposit, we do not take
  card details over the phone, and you must never ask for a card number. If somebody offers
  to pay now, tell them there is nothing to pay until they are in the chair.
- How the barbers are paid is not a caller's concern. If it comes up, say the barbers run
  their own chairs, and move on.
- We do not send confirmation texts or emails. Never promise one. The booking is in the
  book — tell them the day, the time and the barber's name, and that is the confirmation.
- We take walk-ins as well as appointments. If somebody asks how long the wait is, use the
  walk-in wait tool. That number is live — do not round it or embellish it.

BOOKING A TIME
1. Find out what they want done, and whether they see a particular barber. "Anyone" is
   fine — the times you offer name a specific barber anyway.
2. Call the tool that finds times. Offer at most three, by time and barber.
3. When they choose, take their first name if you do not already have it.
4. Book it. Then confirm out loud: the day, the time, the barber, what is being done, and
   what it costs.
5. If the time goes between offering and booking, say so plainly and offer the next times
   straight away. It happens; it is nobody's fault.

AN EXISTING BOOKING
- Use the tool to find it. You can only look up bookings for the number they are calling
  from — if their number is withheld, say so and offer to make a new booking instead.
- To move one: find it, then find new times for the SAME service, then move it. Confirm the
  new day, time and barber out loud.
- To cancel: find it, read the day, time and barber back, and only then cancel it. Never
  cancel one they did not name.

WHAT YOU CANNOT DO
- You cannot take payment, give refunds, change prices, or change a barber's hours.
- You cannot put somebody in the walk-in line over the phone — that line is for people in
  the shop. Quote the wait and offer a booked time instead.
- You do not discuss other businesses, and you do not give medical or legal advice.
- If somebody is abusive, tell them you are going to end the call, and end it.`;
}

/**
 * Rings our own doorbell, exactly the way Vapi will.
 *
 * This exists because the greeting silently did not work for three real calls. The phone
 * number was configured with the webhook URL but without the credential header, so every
 * `assistant-request` came back 401 and Vapi quietly fell back to the assistant's static
 * `firstMessage`. Every tool kept working, the calls connected, the bookings went through —
 * and the one feature that had to be configured in a second place simply never happened.
 *
 * Nothing in the test suite could have caught it: the route was right, the service was
 * right, and the mistake was in a config object sent to a third party. The only thing that
 * catches it is asking the question the way the caller's phone will, which is what this
 * does — through the public URL, with the same headers the number now carries, and it
 * refuses to report success unless a real `assistantId` comes back.
 */
async function verifyGreetingHook(serverUrl: string, deviceToken: string): Promise<void> {
  process.stdout.write('  verifying the greeting hook… ');

  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-token': deviceToken },
    body: JSON.stringify({
      message: {
        type: 'assistant-request',
        call: { id: 'provision-selfcheck', customer: { number: '+10000000000' } },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `the webhook answered ${String(response.status)} at ${serverUrl}.\n` +
        'Is the server running, and is VAPI_SERVER_URL pointing at it?',
    );
  }

  const body = (await response.json()) as { assistantId?: unknown };

  if (typeof body.assistantId !== 'string') {
    throw new Error(
      'the webhook answered, but returned no assistantId — so callers will NOT be greeted\n' +
        '  by name and Vapi will fall back to the static first message.\n' +
        '  Set VAPI_ASSISTANT_ID to the id printed below and restart the server, then re-run this.',
    );
  }

  console.log('ok');
}

// --- Provisioning ------------------------------------------------------------

async function main(): Promise<void> {
  const serverUrl = requireServerUrl();
  const deviceToken = requireDeviceToken();
  const client = vapi();

  const [settings, barbers, services] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { id: 1 } }),
    prisma.barber.findMany({ where: { status: 'ACTIVE' }, orderBy: { sortOrder: 'asc' } }),
    prisma.service.findMany({ where: { isActive: true } }),
  ]);

  if (!settings) throw new Error('Shop settings have not been seeded. Run `pnpm db:seed` first.');

  const barberNames = barbers.map((barber) => barber.displayName);
  const todayLocal = DateTime.now().setZone(settings.timezone).toFormat('cccc, d LLLL yyyy');

  /**
   * The credential travels in a header on every tool, not in the URL.
   *
   * A tool-level `server` outranks the assistant's, so this stays correct even if somebody
   * edits the assistant by hand in the dashboard later.
   */
  const server = { url: serverUrl, headers: { 'x-device-token': deviceToken } };

  // --- Tools ---------------------------------------------------------------

  const existingTools = await client.tools.list();
  const toolIds: string[] = [];

  for (const spec of TOOL_SPECS) {
    const payload = {
      type: 'function' as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: {
          type: 'object' as const,
          properties: spec.properties,
          ...(spec.required ? { required: spec.required } : {}),
        },
      },
      server,
    };

    const found = existingTools.find(
      (tool) => 'function' in tool && tool.function?.name === spec.name,
    );

    if (found) {
      await client.tools.update({ id: found.id, body: payload });
      toolIds.push(found.id);
      console.log(`  updated tool  ${spec.name}`);
    } else {
      const created = await client.tools.create(payload);
      toolIds.push(created.id);
      console.log(`  created tool  ${spec.name}`);
    }
  }

  // --- Assistant -----------------------------------------------------------

  /**
   * Everything below the model is about how the call *feels*, and each one earns its place:
   *
   * - `eleven_flash_v2_5` is the lowest-latency ElevenLabs model. On a phone call the gap
   *   before the first syllable is what reads as "robot", far more than the voice itself.
   * - Deepgram `nova-3` with **keyterms taken from this shop's own roster and menu**. A
   *   barber's name is exactly the word a general model gets wrong, and mishearing it makes
   *   the assistant deny knowing somebody the caller just asked for by name.
   * - `smartEndpointingPlan` predicts whether the caller has actually finished rather than
   *   waiting for a fixed silence — the difference between being interrupted mid-sentence
   *   and a second of dead air after every turn.
   * - `stopSpeakingPlan.numWords: 2` with acknowledgement phrases, so "mm-hmm" and "yeah"
   *   do not cut the assistant off. It reads three appointment times aloud; a backchannel
   *   killing that mid-list is the most likely way this feels broken.
   * - `backgroundSound: 'office'` because total silence behind a voice is uncanny, and this
   *   is meant to sound like a front desk.
   */
  const assistantPayload = {
    name: ASSISTANT_NAME,
    firstMessageMode: 'assistant-speaks-first' as const,
    firstMessage: `Thanks for calling ${settings.name}. How can I help?`,

    model: {
      provider: 'openai' as const,
      model: 'gpt-4o' as const,
      // Warm enough not to sound scripted, tight enough not to improvise a price.
      temperature: 0.4,
      messages: [
        { role: 'system' as const, content: systemPrompt(settings.name, barberNames, todayLocal) },
      ],
      toolIds,
    },

    voice: {
      provider: '11labs' as const,
      voiceId: 'cgSgspJ2msm6clMCkdW9',
      model: 'eleven_flash_v2_5' as const,
      // Just under natural pace: a receptionist reading back a time slows down slightly.
      speed: 0.98,
      // Emit as soon as there is a sentence to say, rather than buffering the whole reply.
      chunkPlan: { enabled: true, minCharacters: 30 },
    },

    transcriber: {
      provider: 'deepgram' as const,
      model: 'nova-3' as const,
      language: 'en' as const,
      smartFormat: true,
      keyterm: [...barberNames, ...services.map((service) => service.name)],
    },

    startSpeakingPlan: {
      waitSeconds: 0.4,
      smartEndpointingPlan: {
        provider: 'livekit' as const,
        // Vapi's documented English curve: wait longer when the caller is mid-thought,
        // answer almost immediately once they have clearly finished.
        waitFunction: '2000 / (1 + exp(-10 * (x - 0.5)))',
      },
    },

    stopSpeakingPlan: {
      numWords: 2,
      voiceSeconds: 0.2,
      backoffSeconds: 1,
      acknowledgementPhrases: ['okay', 'right', 'uh-huh', 'yeah', 'mm-hmm', 'got it', 'sure'],
    },

    backgroundSound: 'office' as const,

    // A caller who has gone quiet is usually thinking; twenty seconds then a prompt, and
    // ten minutes is longer than any booking call the shop will ever take.
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 600,
    endCallPhrases: ['goodbye', 'bye now', 'thanks, bye', 'have a good one'],

    server,
  };

  const existingAssistants = await client.assistants.list();
  const existingAssistant = existingAssistants.find((assistant) => ours(assistant.name));

  const assistant = existingAssistant
    ? // The WHOLE model object every time. A PATCH that sends only `toolIds` clobbers the
      // rest of the model configuration — a documented Vapi gotcha, and a quiet one.
      await client.assistants.update({ id: existingAssistant.id, ...assistantPayload })
    : await client.assistants.create(assistantPayload);

  console.log(`  ${existingAssistant ? 'updated' : 'created'} assistant  ${assistant.id}`);

  // --- Phone number --------------------------------------------------------

  const existingNumbers = await client.phoneNumbers.list();
  const existingNumber = existingNumbers.find((number) => ours(number.name));

  let phoneNumberId: string;
  let phoneNumber: string | undefined;

  if (existingNumber) {
    phoneNumberId = existingNumber.id;
    phoneNumber = existingNumber.number;
    console.log(`  reusing number  ${phoneNumber ?? phoneNumberId}`);
  } else {
    // A free Vapi number. Re-running must never mint another — the free allowance is
    // finite, and a script that creates one per run exhausts it in three.
    const created = await client.phoneNumbers.create({
      provider: 'vapi',
      name: PHONE_NUMBER_NAME,
      numberDesiredAreaCode: process.env.VAPI_AREA_CODE ?? '912',
    });
    phoneNumberId = created.id;
    phoneNumber = created.number;
    console.log(`  created number  ${phoneNumber ?? phoneNumberId}`);
  }

  /**
   * `assistantId: null` is the entire point of this call.
   *
   * It is what makes Vapi ask our `assistant-request` hook on every inbound call, which is
   * what lets the greeting name the caller and state their existing booking. Binding an
   * assistant here instead would answer with a static one, and every caller would be a
   * stranger.
   */
  await client.phoneNumbers.update({
    id: phoneNumberId,
    body: {
      provider: 'vapi',
      /**
       * The FULL `server` object — url **and** credential header.
       *
       * This was `{ url: serverUrl }` and the missing header cost a working feature
       * silently. `assistant-request` is the one webhook Vapi sends from the *phone
       * number's* config rather than the assistant's or a tool's, so it is the one place
       * the token has to be repeated. Without it every greeting request was refused 401,
       * Vapi fell back to the assistant's static `firstMessage`, and no caller was ever
       * greeted by name — while every tool kept working, because tools carry their own
       * copy. Nothing looked broken; the feature just never happened.
       */
      server,
      /**
       * `null`, not `undefined`, and the cast is the reason for this comment.
       *
       * The SDK types `assistantId` as `string | undefined`, so `undefined` is simply
       * omitted from the request body and any assistant already bound to the number stays
       * bound. The REST API accepts an explicit null to clear it, and clearing it is the
       * entire point: a number with no assistant is what makes Vapi ask our
       * `assistant-request` hook, which is what lets the greeting name the caller. Bound
       * to a static assistant, every caller is a stranger — and the failure is silent,
       * because the call still connects and the assistant still works.
       *
       * A freshly created number has none anyway; this covers one bound by hand in the
       * dashboard.
       */
      ...({ assistantId: null } as unknown as { assistantId?: string }),
    },
  });

  await verifyGreetingHook(serverUrl, deviceToken);

  console.log('\nDone.');
  console.log(`  Number:        ${phoneNumber ?? '(see the Vapi dashboard)'}`);
  console.log(`  Assistant id:  ${assistant.id}`);
  console.log(`  Webhook:       ${serverUrl}`);
  console.log(`  Token:         …${deviceToken.slice(-4)}`);
  console.log('\nSet VAPI_ASSISTANT_ID to the assistant id above, then restart the server.');
  console.log('Without it the greeting hook answers empty and callers are not greeted by name.');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
