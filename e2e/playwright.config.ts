import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { API_PORT, FIREBASE_E2E_PROJECT, PHONE_WEB_PORT, PREVIEW_PORT, ROOT, WEB, WEB_PORT, serverEnv } from './env';

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
      // Local stand-in for the Firebase Auth emulator's accounts:lookup (firebase-admin always calls it in emulator mode).
      command: 'node --import tsx test/helpers/fake-auth-emulator.ts 9099',
      cwd: api,
      port: 9099,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: 'node --import tsx src/server.ts',
      cwd: api,
      url: `http://localhost:${API_PORT}/health`,
      env: serverEnv,
      reuseExistingServer: false,
      timeout: 60_000
    },
    {
      command: 'corepack pnpm exec vite --port ' + WEB_PORT + ' --strictPort',
      cwd: web,
      url: `http://localhost:${WEB_PORT}/`,
      env: { VITE_API_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000
    },
    {
      command: 'corepack pnpm exec vite build && corepack pnpm exec vite preview --port ' + PREVIEW_PORT + ' --strictPort',
      cwd: web,
      url: `http://localhost:${PREVIEW_PORT}/`,
      env: { VITE_API_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      // Phone sign-in enabled with the build-time mock Firebase client (OTP 123456). Dummy web config: nothing here is a secret.
      command: 'corepack pnpm exec vite --port ' + PHONE_WEB_PORT + ' --strictPort',
      cwd: web,
      url: `http://localhost:${PHONE_WEB_PORT}/`,
      env: {
        VITE_API_TARGET: `http://localhost:${API_PORT}`,
        // This server is on another port than the API's WEB_ORIGIN; the dev proxy presents the configured origin to the API.
        VITE_PROXY_SET_ORIGIN: WEB,
        VITE_PHONE_AUTH_MOCK: '1',
        VITE_FIREBASE_API_KEY: 'e2e-dummy-api-key',
        VITE_FIREBASE_AUTH_DOMAIN: `${FIREBASE_E2E_PROJECT}.firebaseapp.com`,
        VITE_FIREBASE_PROJECT_ID: FIREBASE_E2E_PROJECT,
        VITE_FIREBASE_APP_ID: '1:000000000000:web:e2e'
      },
      reuseExistingServer: false,
      timeout: 60_000
    }
  ]
});
