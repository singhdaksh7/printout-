import { execSync } from 'node:child_process';
import { TEST_DATABASE_URL } from '../vitest.config.js';

// Applies checked-in migrations to the isolated test database (never `db push`, never `migrate reset`).
export default function setup() {
  const url = new URL(TEST_DATABASE_URL.replace(/^postgresql:/, 'http:'));
  if (!/test/.test(url.pathname)) throw new Error(`Refusing to run tests against non-test database: ${url.pathname}`);
  execSync('corepack pnpm exec prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }
  });
}
