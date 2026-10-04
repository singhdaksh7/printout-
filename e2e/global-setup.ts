import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DB_URL, ROOT, SEED_PASSWORD, UPLOAD_DIR, serverEnv } from './env';

/** Resets the PRIVATE e2e database (never `printout`), seeds demo data and starts the retention worker. */
export default async function globalSetup() {
  if (!/\/printout_e2e\b/.test(DB_URL)) throw new Error('refusing to run against a non-e2e database');
  const sql = `DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP EXECUTE 'TRUNCATE TABLE "' || r.tablename || '" RESTART IDENTITY CASCADE'; END LOOP; END $$;`;
  execFileSync('docker', ['exec', 'print-codex-postgres-1', 'psql', '-U', 'printout', '-d', 'printout_e2e', '-c', sql], { stdio: 'pipe' });
  const api = path.join(ROOT, 'apps', 'api');
  execFileSync('node', ['--import', 'tsx', 'prisma/seed.ts'], { cwd: api, env: { ...process.env, DATABASE_URL: DB_URL, SEED_PASSWORD }, stdio: 'pipe' });
  rmSync(UPLOAD_DIR, { recursive: true, force: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  mkdirSync(path.join(ROOT, 'e2e', 'artifacts'), { recursive: true });
  rmSync(path.join(ROOT, 'e2e', '.state.json'), { force: true });

  const logFile = path.join(ROOT, 'e2e', '.data', 'worker.log');
  const logFd = openSync(logFile, 'w');
  const worker: ChildProcess = spawn('node', ['--import', 'tsx', 'src/worker.ts'], { cwd: api, env: { ...process.env, ...serverEnv }, stdio: ['ignore', logFd, logFd], windowsHide: true });
  closeSync(logFd);
  await new Promise((r) => setTimeout(r, 4000));
  if (worker.exitCode !== null) throw new Error(`retention worker exited early:
${readFileSync(logFile, 'utf8')}`);
  return async () => {
    if (worker.pid) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { stdio: 'ignore' });
        else worker.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };
}
