import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration files share one Postgres database (orders_test) and truncate it
    // between tests, so files must not run in parallel. Concurrency is exercised
    // inside each test with Promise.all.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
