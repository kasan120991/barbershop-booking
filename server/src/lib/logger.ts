/**
 * Structured logging.
 *
 * Redaction is not cosmetic here: request logs are the most likely place for a
 * client phone number, a session cookie, or a Stripe key to end up in plaintext
 * on disk. The redact list below is a floor, not a ceiling — extend it whenever a
 * new sensitive field starts flowing through a request.
 */

import { pino } from 'pino';

import { env, isDevelopment } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'req.headers["stripe-signature"]',
      'res.headers["set-cookie"]',
      'password',
      'passwordHash',
      '*.password',
      '*.passwordHash',
      '*.phone',
      '*.phoneE164',
    ],
    censor: '[redacted]',
  },
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
