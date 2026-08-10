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
  /** Public booking + kiosk origin. */
  BOOKING_ORIGIN: z.url().default('http://localhost:3001'),

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

/** Origins allowed to send credentialed requests to this API. */
export const allowedOrigins: readonly string[] = [env.APP_ORIGIN, env.BOOKING_ORIGIN];
