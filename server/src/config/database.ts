/**
 * Turns `DATABASE_URL` into the option object the MariaDB driver adapter needs.
 *
 * Why this exists: `@prisma/adapter-mariadb` does NOT accept a `url` option — passing
 * one yields no connection and surfaces as a confusing "pool timeout after 10000ms"
 * rather than a parse error. It wants discrete host/port/user/password/database.
 * The Prisma CLI (migrate, studio) still reads the URL from `prisma.config.ts`, so
 * the URL stays the single source of truth and is parsed here for runtime use.
 */

export interface MariaDbConnectionOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function parseDatabaseUrl(databaseUrl: string): MariaDbConnectionOptions {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL — expected mysql://user:pass@host:port/db');
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error('DATABASE_URL is missing a database name — expected .../<database>');
  }

  return {
    host: parsed.hostname,
    // MySQL's default, used when the URL omits a port.
    port: parsed.port ? Number(parsed.port) : 3306,
    // Credentials are percent-encoded in a URL; a password with @ or / would
    // otherwise arrive mangled.
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}
