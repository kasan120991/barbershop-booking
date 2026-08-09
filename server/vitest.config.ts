import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Phase 1 has no database access; a placeholder keeps env validation happy
      // so tests exercise the real config path rather than a mocked one.
      DATABASE_URL: 'mysql://francis:francis@localhost:3306/francis_cutz_test',
    },
  },
});
