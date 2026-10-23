import path from 'node:path';

export const ROOT = path.resolve(__dirname, '..');
// Override when another project is already using the default (E2E_API_PORT=3199 pnpm e2e).
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5273);
export const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT ?? 5274);
// Dedicated web server with phone sign-in switched on (mock Firebase client). Every other spec keeps the email-only login screen.
export const PHONE_WEB_PORT = Number(process.env.E2E_PHONE_WEB_PORT ?? 5276);
export const PHONE_WEB = `http://localhost:${PHONE_WEB_PORT}`;
export const FIREBASE_E2E_PROJECT = 'printout-e2e';
export const API = `http://localhost:${API_PORT}`;
export const WEB = `http://localhost:${WEB_PORT}`;
export const PREVIEW = `http://localhost:${PREVIEW_PORT}`;
// Defaults match docker-compose.yml. Override when that port is unavailable (e.g. inside a Windows-reserved port range):
//   E2E_DB_PORT=55550 E2E_PG_CONTAINER=<disposable postgres container> pnpm e2e
export const DB_PORT = process.env.E2E_DB_PORT ?? '55433';
export const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'print-codex-postgres-1';
export const DB_URL = `postgresql://printout:change-me@localhost:${DB_PORT}/printout_e2e?schema=public`;
export const UPLOAD_DIR = path.join(ROOT, 'e2e', '.data', 'uploads');
export const RETENTION_MINUTES = 1;
export const SEED_PASSWORD = 'change-this-development-password';
export const MAX_BYTES = 5 * 1024 * 1024;

/** Environment shared by the API and the retention worker. */
export const serverEnv: Record<string, string> = {
  NODE_ENV: 'development',
  API_PORT: String(API_PORT),
  DATABASE_URL: DB_URL,
  SESSION_SECRET: 'e2e-session-secret-0123456789abcdefghijkl',
  CSRF_SECRET: 'e2e-csrf-secret-0123456789abcdefghijklmn',
  WEB_ORIGIN: WEB,
  STORAGE_DRIVER: 'local',
  LOCAL_UPLOAD_DIR: UPLOAD_DIR,
  PRINT_RETENTION_MINUTES: String(RETENTION_MINUTES),
  UPLOAD_MAX_BYTES: String(MAX_BYTES),
  DOCUMENT_CLEANUP_INTERVAL_MINUTES: '0.05',
  LOGIN_RATE_LIMIT_MAX: '1000',
  LOGIN_FAIL_MAX: '1000',
  PUBLIC_RATE_LIMIT_MAX: '5000',
  SSE_HEARTBEAT_MS: '5000',
  // Disposable test-only key for the admin two-factor e2e.
  TWO_FACTOR_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  // Phone sign-in. FIREBASE_AUTH_EMULATOR_HOST makes the REAL firebase-admin accept unsigned (alg=none) test tokens while still
  // checking project, issuer, expiry and claims; no network call is made. The API refuses this variable in production.
  FIREBASE_PROJECT_ID: FIREBASE_E2E_PROJECT,
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIREBASE_CHECK_REVOKED: 'false',
  PHONE_ALLOWED_CALLING_CODES: '+91'
};
