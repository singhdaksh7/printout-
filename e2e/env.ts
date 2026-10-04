import path from 'node:path';

export const ROOT = path.resolve(__dirname, '..');
export const API_PORT = 3100;
export const WEB_PORT = 5273;
export const PREVIEW_PORT = 5274;
export const API = `http://localhost:${API_PORT}`;
export const WEB = `http://localhost:${WEB_PORT}`;
export const PREVIEW = `http://localhost:${PREVIEW_PORT}`;
export const DB_URL = 'postgresql://printout:change-me@localhost:55433/printout_e2e?schema=public';
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
  SSE_HEARTBEAT_MS: '5000'
};
