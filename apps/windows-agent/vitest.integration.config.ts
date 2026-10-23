import { defineConfig } from 'vitest/config';

// Runs the REAL agent engine against the REAL API (Fastify + PostgreSQL) with a fake spooler. Needs TEST_DATABASE_URL.
const url = process.env.TEST_DATABASE_URL ?? 'postgresql://printout:change-me@localhost:55433/printout_test?schema=public';
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: url,
      TEST_DATABASE_URL: url,
      SESSION_SECRET: 'test-session-secret-0123456789abcdefghij',
      CSRF_SECRET: 'test-csrf-secret-0123456789abcdefghijk',
      WEB_ORIGIN: 'http://localhost:5173',
      STORAGE_DRIVER: 'local',
      LOCAL_UPLOAD_DIR: '.data/test-uploads'
    }
  }
});
