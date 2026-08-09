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
  },
});
