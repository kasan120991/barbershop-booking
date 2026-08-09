import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Database-backed tests write real rows, so they run against a SEPARATE database
    // and must never touch development data. Create and migrate it with:
    //   pnpm --filter @francis/server run db:test:setup
    // Tests that need a database skip cleanly when it is unreachable.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      TZ: 'UTC',
      DATABASE_URL: 'mysql://root:root@127.0.0.1:8889/francis_cutz_test',
    },
    // The Prisma client is heavy to import; give DB suites room on a cold start.
    testTimeout: 20_000,
    hookTimeout: 20_000,

    /**
     * Test files run one at a time.
     *
     * They share a single MySQL database and each sets up its own fixtures across
     * FK-linked tables (`users` -> `barbers` -> `services`). Run in parallel, two
     * workers deleting overlapping index ranges take conflicting InnoDB gap locks and
     * MySQL kills one with "write conflict or deadlock" — intermittently, and in
     * whichever file lost the race rather than the one that caused it.
     *
     * Namespacing fixtures per file (which they do) prevents them from seeing each
     * other's *data*; it cannot prevent lock contention on shared indexes. The real
     * options were a database per worker or no parallelism, and for a suite that
     * spends ~18s in tests, serial is the cheaper correct answer.
     */
    fileParallelism: false,
  },
});
