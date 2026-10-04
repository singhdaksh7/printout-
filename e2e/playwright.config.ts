import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { API_PORT, PREVIEW_PORT, ROOT, WEB, WEB_PORT, serverEnv } from './env';

const api = path.join(ROOT, 'apps', 'api');
const web = path.join(ROOT, 'apps', 'web');

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: { baseURL: WEB, ...devices['Desktop Chrome'], trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    {
      command: 'node --import tsx src/server.ts',
      cwd: api,
      url: `http://localhost:${API_PORT}/health`,
      env: serverEnv,
      reuseExistingServer: false,
      timeout: 60_000
    },
    {
      command: 'corepack pnpm exec vite --port 5273 --strictPort',
      cwd: web,
      url: `http://localhost:${WEB_PORT}/`,
      env: { VITE_API_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000
    },
    {
      command: 'corepack pnpm exec vite build && corepack pnpm exec vite preview --port 5274 --strictPort',
      cwd: web,
      url: `http://localhost:${PREVIEW_PORT}/`,
      env: { VITE_API_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
