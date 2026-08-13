/**
 * Environment parsing and validation.
 *
 * The process fails loudly here at startup rather than throwing a confusing
 * undefined error three layers deep during the first request. This is the ONLY
 * module that reads `process.env` — everything else imports `env`.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().min(1, { error: 'DATABASE_URL is required — see .env.example' }),

  /** Staff app origin. Must be exact — it is used for the CORS allowlist and cookies. */
  APP_ORIGIN: z.url().default('http://localhost:3000'),
  /**
   * Public booking + kiosk origin.
   *
   * Also the origin every customer-facing link is BUILT from — the payment QR code most
   * of all. It has to be an address the customer's own phone can reach, which `localhost`
   * never is, so on a real shop network this is the machine's LAN address (or a public
   * hostname) rather than loopback.
   */
  BOOKING_ORIGIN: z.url().default('http://localhost:3001'),

  /**
   * Additional origins allowed to call the API, comma-separated.
   *
   * Separate from the two above rather than making them lists, because those answer
   * "where do I send someone", which has exactly one answer. This answers "who may call
   * me", which legitimately has several: the same app is reachable at `localhost:3001`
   * from this machine and at `192.168.1.175:3001` from a tablet on the shop wifi, and
   * both must pass CORS while only one can appear in a link.
   *
   * Still an exact allowlist — every entry is written down. No wildcards, no regex.
   */
  EXTRA_ORIGINS: z.string().optional(),

  /**
   * Staff sessions are absolute, not sliding: 12 hours covers a shift, and a device
   * left on the counter stops being a way in by the next morning.
   */
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(24 * 30).default(12),

  /**
   * Cookie scope. Leave UNSET in development: localhost cookies ignore ports, so a
   * host-only cookie is already shared between the app on :3000 and the API on :4000.
   *
   * In production the app and API live on different subdomains, and a host-only
   * cookie set by api.example.com is never sent to app.example.com — which means
   * Nuxt's server has nothing to forward and SSR auth fails while working perfectly
   * in dev. Set this to the shared parent (".example.com") to fix that.
   */
  COOKIE_DOMAIN: z.string().min(1).optional(),

  /** Login attempts allowed per IP within the window, before the account lockout can even be reached. */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

  /**
   * Stripe platform secret key.
   *
   * Optional on purpose. Every phase before this one boots and its whole test suite
   * runs without a Stripe account, and a required key here would mean nobody can work
   * on the queue or the calendar without provisioning one. `lib/stripe.ts` throws a
   * named error the first time a payment path is actually reached instead, so the
   * failure names the missing key rather than surfacing as `undefined` inside the SDK.
   *
   * Must be a test key (`sk_test_`/`rk_test_`) unless NODE_ENV is production — see
   * the refinement below.
   */
  /**
   * Vapi — the phone receptionist.
   *
   * All optional, and the server boots and the whole suite passes with none of them set.
   * The RUNTIME path needs none at all: the webhook only ever *receives*, and it
   * authenticates the caller with a device token, which is a database row rather than an
   * environment variable. That is deliberate — the phone line's credential is issued from
   * the admin screen and lives in Vapi's own config, so a redeploy cannot leak it and
   * revoking it is one click rather than a release.
   *
   * `VAPI_API_KEY` is used by `scripts/provision-vapi.ts` only, and `lib/vapi.ts` throws a
   * named error the first time it is needed without one.
   */
  VAPI_API_KEY: z.string().min(1).optional(),

  /**
   * The assistant answered with on an `assistant-request`. Unset means the webhook answers
   * an empty 200 and Vapi falls back to whatever the number is bound to — so a missing
   * value degrades to "no greeting by name", never to a dropped call.
   */
  VAPI_ASSISTANT_ID: z.string().min(1).optional(),

  /** Provisioning only. Set once the script has bound a number. */
  VAPI_PHONE_NUMBER_ID: z.string().min(1).optional(),

  /**
   * The PUBLIC origin Vapi reaches this server on, written into the assistant's tool
   * `server.url` by the provisioning script — a tunnel in development, the deployed host
   * in production.
   *
   * Separate from APP_ORIGIN and BOOKING_ORIGIN, which answer "where do I send a person".
   * This one answers "where does a machine call us back".
   */
  VAPI_SERVER_URL: z.url().optional(),

  STRIPE_SECRET_KEY: z.string().min(1).optional(),

  /**
   * Signing secret for the Stripe webhook endpoint.
   *
   * Optional for the same reason as the key above — but note the consequence is
   * different. Without it the endpoint does not fall back to trusting the body; it
   * refuses every delivery. An unverified webhook is an unauthenticated POST that moves
   * money, so "not configured" has to mean closed, never open.
   *
   * Local value comes from `stripe listen`, which prints a `whsec_…` per session. The
   * deployed endpoint has its own, from the Dashboard.
   */
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * Stripe publishable key, for the Payment Element on the customer's checkout page.
   *
   * Lives here rather than in `booking`'s runtime config on purpose. The checkout
   * endpoint already has to tell the browser which connected account to initialise
   * Stripe.js against, so handing back the key beside it keeps the pair in one file —
   * a second copy in a second app is a copy that can drift out of step with the secret
   * key it has to match, and the symptom of that is a checkout page that mounts and
   * then rejects every card.
   *
   * Publishable by definition: it ships to every browser and is not a secret.
   */
  STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
})
  /**
   * A live key in a dev shell would take real money on a real barber's account from a
   * laptop pointed at a seeded database. Cheap to check once at boot; impossible to
   * notice otherwise until it has happened.
   */
  .refine(
    (value) =>
      value.NODE_ENV === 'production' ||
      value.STRIPE_SECRET_KEY === undefined ||
      !value.STRIPE_SECRET_KEY.startsWith('sk_live_'),
    { error: 'STRIPE_SECRET_KEY is a LIVE key but NODE_ENV is not production.', path: ['STRIPE_SECRET_KEY'] },
  );

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    const details = Object.entries(fieldErrors)
      .map(([key, messages]) => `  ${key}: ${messages?.join(', ') ?? 'invalid'}`)
      .join('\n');

    // Deliberately console + exit rather than throw: the logger itself depends on
    // LOG_LEVEL, so it may not be safe to construct yet.
    console.error(`Invalid environment configuration:\n${details}`);
    process.exit(1);
  }

  return parsed.data;
}

export const env = parseEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

/**
 * Origins allowed to send credentialed requests to this API.
 *
 * The two canonical origins plus anything in `EXTRA_ORIGINS`, deduplicated. Blank entries
 * are dropped so a trailing comma cannot put `''` in the list — `cors` treats an empty
 * string as no-origin, which would quietly widen this rather than fail loudly.
 */
export const allowedOrigins: readonly string[] = [
  ...new Set(
    [
      env.APP_ORIGIN,
      env.BOOKING_ORIGIN,
      ...(env.EXTRA_ORIGINS?.split(',') ?? []),
    ]
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  ),
];
