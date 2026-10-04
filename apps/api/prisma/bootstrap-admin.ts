/**
 * Production bootstrap: creates a PLATFORM_ADMIN (never creates demo data).
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' node dist/prisma/bootstrap-admin.js     (container)
 *   ADMIN_EMAIL=you@example.com tsx prisma/bootstrap-admin.ts                                (dev; prompts for the password on a TTY)
 *
 * - Credentials come only from the environment (ADMIN_EMAIL, ADMIN_PASSWORD, optional ADMIN_NAME). When ADMIN_PASSWORD is
 *   missing and stdin is a TTY the password is read from a hidden prompt (twice). There is NO default password.
 * - Password policy: >= 12 characters, no placeholders / trivially weak values. Stored as Argon2id. Never printed or logged.
 * - Idempotent: if a PLATFORM_ADMIN with that email already exists nothing changes (exit 0) unless ADMIN_RESET_PASSWORD=1.
 *   Other admins existing does not block creating this one (it is reported).
 * - NODE_ENV=production requires DATABASE_URL to be set explicitly (no implicit fallback to a default database).
 * - Exit codes: 0 created / already exists / reset; 1 unexpected runtime failure (e.g. database unreachable);
 *   2 invalid input or refused (bad email/password, email belongs to a non-admin, missing DATABASE_URL in production).
 */
import { PrismaClient, Role } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../src/auth.js';

export class BootstrapError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 1 | 2 = 2
  ) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export interface BootstrapResult {
  outcome: 'created' | 'exists' | 'reset';
  message: string;
}

export interface BootstrapEnv {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_NAME?: string;
  ADMIN_RESET_PASSWORD?: string;
}

const MIN_PASSWORD_LENGTH = 12;
const PLACEHOLDER = /change-?this|change-?me|replace|placeholder|your-?password|example/i;
const COMMON = new Set([
  'password1234',
  'password12345',
  'passwordpassword',
  'qwertyuiop12',
  'qwertyuiopas',
  'administrator',
  'administrator1',
  '123456789012',
  '1234567890123',
  'adminadmin12',
  'letmeinletmein',
  'iloveyouiloveyou'
]);

/** Returns a human-readable reason when the password is not acceptable, otherwise undefined. */
export function passwordProblem(password: string, email?: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 256) return 'ADMIN_PASSWORD must be at most 256 characters';
  if (PLACEHOLDER.test(password)) return 'ADMIN_PASSWORD looks like a placeholder';
  if (new Set(password).size < 5) return 'ADMIN_PASSWORD is too repetitive';
  if (COMMON.has(password.toLowerCase())) return 'ADMIN_PASSWORD is a commonly used password';
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return 'ADMIN_PASSWORD must not contain the email name';
  return undefined;
}

type Db = Pick<PrismaClient, 'user' | 'session' | 'auditLog' | '$transaction'>;

/** Core logic (exported for tests); the CLI wrapper below only wires env, prompt, exit codes and the Prisma client. */
export async function bootstrapAdmin(prisma: Db, env: BootstrapEnv): Promise<BootstrapResult> {
  if (env.NODE_ENV === 'production' && !env.DATABASE_URL?.trim()) {
    throw new BootstrapError('DATABASE_URL must be set explicitly when NODE_ENV=production');
  }
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new BootstrapError('ADMIN_EMAIL is required and must be an email address');
  }
  const password = env.ADMIN_PASSWORD;
  if (!password) throw new BootstrapError('ADMIN_PASSWORD is required (min 12 characters); there is no default');
  const problem = passwordProblem(password, email);
  if (problem) throw new BootstrapError(problem);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== Role.PLATFORM_ADMIN) {
      throw new BootstrapError(`${email} exists but is not a PLATFORM_ADMIN; refusing to change its role`);
    }
    if (env.ADMIN_RESET_PASSWORD !== '1') {
      return { outcome: 'exists', message: `Platform admin ${email} already exists; nothing to do (set ADMIN_RESET_PASSWORD=1 to reset its password).` };
    }
    const passwordHash = await hashPassword(password);
    await prisma.$transaction([
      prisma.user.update({ where: { id: existing.id }, data: { passwordHash } }),
      prisma.session.updateMany({ where: { userId: existing.id, invalidatedAt: null }, data: { invalidatedAt: new Date() } }),
      prisma.auditLog.create({ data: { shopId: null, actorUserId: null, action: 'admin.bootstrap.reset', targetType: 'user', targetId: existing.id } })
    ]);
    return { outcome: 'reset', message: `Password reset for platform admin ${email}; existing sessions invalidated.` };
  }

  const otherAdmins = await prisma.user.count({ where: { role: Role.PLATFORM_ADMIN } });
  const passwordHash = await hashPassword(password);
  const created = await prisma.user.create({
    data: { email, displayName: env.ADMIN_NAME?.trim() || 'Platform Admin', passwordHash, role: Role.PLATFORM_ADMIN }
  });
  await prisma.auditLog.create({
    data: { shopId: null, actorUserId: null, action: 'admin.bootstrap.create', targetType: 'user', targetId: created.id }
  });
  const note = otherAdmins > 0 ? ` (${otherAdmins} other platform admin${otherAdmins === 1 ? '' : 's'} already exist${otherAdmins === 1 ? 's' : ''})` : '';
  return { outcome: 'created', message: `Created platform admin ${email}${note}.` };
}

/** Reads one line from a TTY without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function cli(): Promise<number> {
  const env: BootstrapEnv = { ...process.env };
  try {
    if (!env.ADMIN_PASSWORD && process.stdin.isTTY) {
      const first = await promptHidden('Admin password (min 12 chars, input hidden): ');
      const second = await promptHidden('Repeat password: ');
      if (first !== second) throw new BootstrapError('Passwords do not match');
      env.ADMIN_PASSWORD = first;
    }
    const prisma = new PrismaClient();
    try {
      const result = await bootstrapAdmin(prisma, env);
      console.log(result.message);
      return 0;
    } finally {
      await prisma.$disconnect();
    }
  } catch (error) {
    if (error instanceof BootstrapError) {
      console.error(`bootstrap-admin: ${error.message}`);
      return error.exitCode;
    }
    // Unexpected (e.g. database unreachable). Name only: ORM messages can embed query arguments.
    console.error(`bootstrap-admin: failed (${error instanceof Error ? error.name : 'unknown error'}); is DATABASE_URL reachable and migrated?`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void cli().then((code) => process.exit(code));
}
