import { defineConfig } from 'vitest/config';

// Tests that touch PostgreSQL share ONE isolated database (printout_test), so files run serially.
// Never point TEST_DATABASE_URL at a non-test database: helpers/db.ts truncates every table.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://printout:change-me@localhost:55433/printout_test?schema=public';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      SESSION_SECRET: 'test-session-secret-0123456789abcdefghij',
      CSRF_SECRET: 'test-csrf-secret-0123456789abcdefghijk',
      WEB_ORIGIN: 'http://localhost:5173',
      STORAGE_DRIVER: 'local',
      LOCAL_UPLOAD_DIR: '.data/test-uploads'
    }
  }
});
