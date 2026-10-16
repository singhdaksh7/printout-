import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// UI-only checks (component showcase, accessibility, screenshots). Needs just the Vite dev server: no API, no database.
// Run: corepack pnpm e2e:ui
const ROOT = path.resolve(__dirname, '..');
const PORT = 5275;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  outputDir: 'test-results',
  fullyParallel: true,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  webServer: {
    command: `corepack pnpm exec vite --port ${PORT} --strictPort`,
    cwd: path.join(ROOT, 'apps', 'web'),
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000
  }
});
