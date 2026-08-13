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

      /**
       * Fake, and never used against the network.
       *
       * `constructEvent` is local HMAC — it needs a client instance and a signing secret,
       * neither of which it sends anywhere. That lets the webhook tests sign their own
       * fixtures and assert the real verification path rather than stubbing past it.
       *
       * Any test that would make an actual Stripe call is the one thing these must not
       * enable, which is why nothing in the suite exercises a network-bound Stripe path.
       */
      STRIPE_SECRET_KEY: 'sk_test_fixture_key_not_a_real_account',
      STRIPE_WEBHOOK_SECRET: 'whsec_fixture_secret_for_signing_tests',

      /**
       * Pinned for the same reason as the Stripe keys: the suite must answer the same
       * way on every machine.
       *
       * This one was learned the hard way. The greeting-hook test asserted the
       * *unconfigured* path — an empty 200 — and passed only because nobody had
       * provisioned Vapi yet. The moment a real `VAPI_ASSISTANT_ID` landed in `.env`,
       * dotenv handed it to the suite and the test failed on a developer's machine while
       * the code was perfectly correct. A test that depends on what somebody has set up
       * locally is not a test.
       *
       * `VAPI_API_KEY` stays deliberately UNSET: nothing in the suite may reach Vapi's
       * API, and `lib/vapi.ts` throwing a named error is the behaviour we want if
       * anything ever tries.
       */
      VAPI_ASSISTANT_ID: 'asst_fixture_not_a_real_assistant',
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
