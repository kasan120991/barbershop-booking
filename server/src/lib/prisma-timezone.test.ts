/**
 * Proves that timestamps land in UTC, not the machine's local zone.
 *
 * This is not a theoretical concern. MySQL `DATETIME` carries no timezone, and the
 * migration emits `DEFAULT CURRENT_TIMESTAMP(3)`, which resolves in the *session*
 * timezone. The local MAMP MySQL runs as EDT and is shared with other projects, so
 * we cannot change its global `time_zone` — instead the driver adapter pins the
 * session to UTC via `timezone: 'Z'`.
 *
 * If that option is ever dropped, every stored instant silently shifts by the UTC
 * offset, and shifts again when DST flips. These tests fail loudly instead.
 *
 * Requires MAMP MySQL to be running; skips cleanly if it is not, so the suite still
 * passes on a machine without a database.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { prisma } from './prisma.js';

const TEST_PHONE = '+14155550999';

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

afterAll(async () => {
  if (reachable) {
    await prisma.client.deleteMany({ where: { phoneE164: TEST_PHONE } });
    await prisma.$disconnect();
  }
});

describe.skipIf(!reachable)('database timezone', () => {
  it('runs the session in UTC', async () => {
    const rows = await prisma.$queryRaw<Array<{ tz: string }>>`SELECT @@session.time_zone AS tz`;
    expect(rows[0]?.tz).toBe('+00:00');
  });

  it('resolves CURRENT_TIMESTAMP to UTC, not local time', async () => {
    const before = Date.now();
    const created = await prisma.client.create({
      data: { phoneE164: TEST_PHONE, firstName: 'Timezone', lastName: 'Probe' },
    });
    const after = Date.now();

    // createdAt comes from the DB default, so this only holds if the session is UTC.
    // An EDT session would put it hours outside this window.
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(created.createdAt.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it('round-trips an explicit UTC instant without shifting it', async () => {
    // A winter instant: EDT is UTC-4, EST is UTC-5, so a timezone bug shows up as a
    // whole-hour offset here rather than a subtle one.
    const instant = new Date('2026-01-15T14:30:00.000Z');

    const updated = await prisma.client.update({
      where: { phoneE164: TEST_PHONE },
      data: { lastVisitAt: instant },
    });

    expect(updated.lastVisitAt?.toISOString()).toBe('2026-01-15T14:30:00.000Z');

    // And confirm the bytes actually on disk are the UTC wall-clock, not a shifted one.
    // NB: `stored` is a reserved word in MySQL 8 (generated columns), hence the alias.
    const raw = await prisma.$queryRaw<Array<{ storedValue: string }>>`
      SELECT DATE_FORMAT(lastVisitAt, '%Y-%m-%d %H:%i:%s') AS storedValue
      FROM clients WHERE phoneE164 = ${TEST_PHONE}
    `;
    expect(raw[0]?.storedValue).toBe('2026-01-15 14:30:00');
  });
});
