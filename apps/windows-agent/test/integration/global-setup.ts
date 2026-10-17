import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// Applies the checked-in migrations to the isolated TEST database (never db push / migrate reset).
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? '';
  if (!/printout_test|_test\b/.test(url)) throw new Error('Refusing to run integration tests against a non-test database');
  execSync('corepack pnpm exec prisma migrate deploy', { cwd: resolve(__dirname, '../../../api'), stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } });
}
