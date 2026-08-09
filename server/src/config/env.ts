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

  /** Login attempts allowed per IP within the window, before the account lockout can even be reached. */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
});

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
