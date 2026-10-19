/**
 * Change the email and/or password of an EXISTING platform admin.
 *
 *   CURRENT_EMAIL=old@example.com NEW_EMAIL=new@example.com corepack pnpm admin:update            (email only)
 *   CURRENT_EMAIL=old@example.com corepack pnpm admin:update                                      (prompts for a new password, hidden)
 *   CURRENT_EMAIL=old@example.com NEW_EMAIL=new@example.com NEW_PASSWORD='...' node dist/prisma/update-admin.js   (container)
 *
 * - DATABASE_URL must be set explicitly: the script acts on whatever database it points at. Check it first.
 * - Password policy is the same as bootstrap-admin (>= 12 chars, no placeholders). Stored as Argon2id, never printed.
 * - Changing either value invalidates that admin's existing sessions and writes an audit entry (ids only).
 * - Refuses non-admin accounts and a NEW_EMAIL that already belongs to another user. Exit: 0 ok, 1 runtime failure, 2 refused.
 */
import { PrismaClient, Role } from '@prisma/client';
import { createInterface } from 'node:readline/promises';
import { hashPassword, rewrapLike } from '../src/auth.js';
import { passwordProblem } from './bootstrap-admin.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stderr.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<number> {
  const fail = (m: string, code: 1 | 2 = 2) => { console.error(`update-admin: ${m}`); return code; };
  if (!process.env.DATABASE_URL?.trim()) return fail('DATABASE_URL must be set explicitly');
  const current = process.env.CURRENT_EMAIL?.trim().toLowerCase();
  if (!current) return fail('CURRENT_EMAIL is required (the admin to change)');
  const next = process.env.NEW_EMAIL?.trim().toLowerCase() || undefined;
  if (next && (next.length > 254 || !EMAIL.test(next))) return fail('NEW_EMAIL must be an email address');
  let password = process.env.NEW_PASSWORD || undefined;
  if (!next && !password && process.stdin.isTTY) {
    const a = await promptHidden('New password (min 12 chars, input hidden): ');
    const b = await promptHidden('Repeat password: ');
    if (a !== b) return fail('Passwords do not match');
    password = a;
  } else if (!password && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question('Also change the password? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer === 'y') {
      const a = await promptHidden('New password (min 12 chars, input hidden): ');
      const b = await promptHidden('Repeat password: ');
      if (a !== b) return fail('Passwords do not match');
      password = a;
    }
  }
  if (!next && !password) return fail('nothing to change: give NEW_EMAIL and/or a new password');
  if (password) {
    const problem = passwordProblem(password, next ?? current)?.replace('ADMIN_PASSWORD', 'password');
    if (problem) return fail(problem);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email: current } });
    if (!user) return fail(`no user with email ${current}`);
    if (user.role !== Role.PLATFORM_ADMIN) return fail(`${current} is not a PLATFORM_ADMIN; refusing`);
    if (next && next !== current && (await prisma.user.findUnique({ where: { email: next } }))) return fail(`${next} already belongs to another user`);
    const data: { email?: string; passwordHash?: string } = {};
    if (next) data.email = next;
    if (password) data.passwordHash = rewrapLike(user.passwordHash, await hashPassword(password));
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data }),
      prisma.session.updateMany({ where: { userId: user.id, invalidatedAt: null }, data: { invalidatedAt: new Date() } }),
      prisma.adminLoginChallenge.deleteMany({ where: { userId: user.id } }),
      prisma.auditLog.create({ data: { shopId: null, actorUserId: null, action: 'admin.credentials.update', targetType: 'user', targetId: user.id, metadata: { emailChanged: !!next, passwordChanged: !!password } } })
    ]);
    console.log(`Updated platform admin${next ? ` (email is now ${next})` : ''}${password ? ' (password changed)' : ''}; existing sessions invalidated.`);
    return 0;
  } catch (e) {
    return fail(`failed (${e instanceof Error ? e.name : 'unknown error'}); is DATABASE_URL reachable and migrated?`, 1);
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((c) => process.exit(c));
