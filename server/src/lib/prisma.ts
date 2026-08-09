/**
 * The Prisma client singleton.
 *
 * Prisma 7 requires a driver adapter; for MySQL that is `@prisma/adapter-mariadb`,
 * which speaks the MySQL wire protocol.
 *
 * The `timezone` option is load-bearing, not cosmetic. The local MAMP MySQL runs in
 * the machine's zone (EDT) and is shared with other projects, so we cannot change its
 * global `time_zone`. Pinning the SESSION zone to UTC means every DATETIME written
 * and read on this connection is an unambiguous UTC instant, and any DB-side
 * CURRENT_TIMESTAMP default resolves to UTC rather than local wall-clock time.
 * Without it, every stored timestamp would be off by the UTC offset — and would
 * silently change by an hour twice a year.
 */

import { PrismaMariaDb } from '@prisma/adapter-mariadb';

import { parseDatabaseUrl } from '../config/database.js';
import { env, isDevelopment } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { logger } from './logger.js';

const adapter = new PrismaMariaDb({
  ...parseDatabaseUrl(env.DATABASE_URL),
  timezone: 'Z',
  connectionLimit: 10,
});

export const prisma = new PrismaClient({
  adapter,
  log: isDevelopment
    ? [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ]
    : [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
});

if (isDevelopment) {
  prisma.$on('query', (event) => {
    logger.debug({ query: event.query, durationMs: event.duration }, 'prisma query');
  });
}

prisma.$on('warn', (event) => logger.warn({ target: event.target }, event.message));
prisma.$on('error', (event) => logger.error({ target: event.target }, event.message));

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
