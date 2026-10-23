import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, isWrappedHash, unwrapHash, verifyPassword } from '../src/auth.js';
import { buildKeyring, openSecret } from '../src/two-factor/crypto.js';
import { base32Decode, hotp, timeStep } from '../src/two-factor/totp.js';
import { buildApp, call, login, PASSWORD, seedWorld, type World } from './api-helpers.js';

const key = (byte: number) => Buffer.alloc(32, byte).toString('base64');

describe('operator CLIs for admin two-factor', () => {
  const ctx = buildApp();
  const apiDir = path.resolve(__dirname, '..');
  let world: World;
  beforeAll(async () => ctx.app.ready());
  afterAll(async () => ctx.app.close());
  beforeEach(async () => {
    world = await seedWorld(ctx.prisma);
  });

  const run = (script: string, env: Record<string, string>) =>
    spawnSync('node', ['--import', 'tsx', `prisma/${script}`], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL!, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90_000
    });
  const output = (r: ReturnType<typeof run>) => `${r.stdout}${r.stderr}`;

  async function enrollAdmin() {
    const admin = await login(ctx.app, world.adminEmail);
    const start = await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll', { currentPassword: PASSWORD });
    const secret = base32Decode(start.json().data.manualKey);
    const done = await call(ctx.app, admin, 'POST', '/admin/account/2fa/enroll/verify', { code: hotp(secret, timeStep(Date.now())) });
    expect(done.statusCode).toBe(200);
    return { admin, secret, recoveryCodes: done.json().data.recoveryCodes as string[] };
  }

  const good = () => ({ CURRENT_EMAIL: world.adminEmail, CONFIRM_EMAIL: world.adminEmail, RESET_REASON: 'ticket OPS-1: phone lost, identity verified on video call' });

  describe('admin:2fa-reset (lost device)', () => {
    it('refuses without every control: database, email, confirmation, reason', async () => {
      await enrollAdmin();
      const cases: Array<[Record<string, string>, RegExp]> = [
        [{ ...good(), DATABASE_URL: '' }, /DATABASE_URL must be set/],
        [{ ...good(), CURRENT_EMAIL: '' }, /CURRENT_EMAIL is required/],
        [{ ...good(), CONFIRM_EMAIL: '' }, /CONFIRM_EMAIL must repeat/],
        [{ ...good(), CONFIRM_EMAIL: 'someone-else@x.test' }, /CONFIRM_EMAIL must repeat/],
        [{ ...good(), RESET_REASON: '' }, /RESET_REASON is required/],
        [{ ...good(), RESET_REASON: 'short' }, /RESET_REASON is required/],
        [{ ...good(), RESET_REASON: 'x'.repeat(301) }, /too long/]
      ];
      for (const [env, message] of cases) {
        const result = run('reset-admin-2fa.ts', env);
        expect(result.status, JSON.stringify(env)).toBe(2);
        expect(output(result)).toMatch(message);
      }
      expect(await ctx.prisma.adminTwoFactor.count()).toBe(1);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'admin.2fa.cli_reset' } })).toBe(0);
    });

    it('refuses non-admins, unknown users and admins without 2FA, and never creates anything', async () => {
      const owner = run('reset-admin-2fa.ts', { CURRENT_EMAIL: world.a.ownerEmail, CONFIRM_EMAIL: world.a.ownerEmail, RESET_REASON: 'ticket OPS-2: attempt on a shop owner' });
      expect(owner.status).toBe(2);
      expect(output(owner)).toMatch(/not a PLATFORM_ADMIN/);
      const ghost = run('reset-admin-2fa.ts', { CURRENT_EMAIL: 'ghost@x.test', CONFIRM_EMAIL: 'ghost@x.test', RESET_REASON: 'ticket OPS-3: nobody here' });
      expect(ghost.status).toBe(2);
      expect(output(ghost)).toMatch(/no user with email/);
      const none = run('reset-admin-2fa.ts', good());
      expect(none.status).toBe(2);
      expect(output(none)).toMatch(/no two-factor enrollment/);
      expect(await ctx.prisma.user.count()).toBe(3);
    });

    it('dry run reports and changes nothing', async () => {
      await enrollAdmin();
      const result = run('reset-admin-2fa.ts', { ...good(), DRY_RUN: '1' });
      expect(result.status).toBe(0);
      expect(output(result)).toMatch(/DRY RUN/);
      expect(await ctx.prisma.adminTwoFactor.count()).toBe(1);
      expect(await ctx.prisma.adminRecoveryCode.count()).toBe(10);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'admin.2fa.cli_reset' } })).toBe(0);
    });

    it('removes the enrollment, ends every session, audits who/why, keeps the password, and prints no secret', async () => {
      const { admin, secret, recoveryCodes } = await enrollAdmin();
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
      const pending = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.adminEmail, password: PASSWORD } });
      expect(pending.json().data.twoFactorRequired).toBe(true);

      const result = run('reset-admin-2fa.ts', good());
      expect(result.status, output(result)).toBe(0);
      const text = output(result);
      for (const secretish of [secret.toString('hex'), secret.toString('base64'), ...recoveryCodes, ...recoveryCodes.map((c) => c.replace('-', '')), user.passwordHash, PASSWORD, key(7)]) {
        expect(text).not.toContain(secretish);
      }

      expect(await ctx.prisma.adminTwoFactor.count()).toBe(0);
      expect(await ctx.prisma.adminRecoveryCode.count()).toBe(0);
      expect(await ctx.prisma.adminLoginChallenge.count()).toBe(0);
      expect(await ctx.prisma.session.count({ where: { userId: admin.userId, invalidatedAt: null } })).toBe(0);
      expect((await call(ctx.app, admin, 'GET', '/admin/account')).statusCode).toBe(401);
      const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
      expect(isWrappedHash(user.passwordHash)).toBe(true); // while enrolled
      expect(isWrappedHash(after.passwordHash)).toBe(false); // restored on reset
      expect(after.passwordHash).toBe(unwrapHash(user.passwordHash)); // the password itself is never changed
      expect(await verifyPassword(after.passwordHash, PASSWORD)).toBe(true);

      const rows = await ctx.prisma.auditLog.findMany({ where: { action: 'admin.2fa.cli_reset' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: 'SYSTEM', targetId: admin.userId });
      expect(rows[0]!.metadata).toMatchObject({ reason: good().RESET_REASON, wasEnabled: true, sessionsEnded: 1 });
      expect(Object.keys(rows[0]!.metadata as object).sort()).toEqual(['host', 'operator', 'reason', 'sessionsEnded', 'wasEnabled']);

      // The admin signs in with the password alone and can enroll again.
      const plain = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.adminEmail, password: PASSWORD } });
      expect(plain.json().data.user.role).toBe('PLATFORM_ADMIN');
      expect(plain.json().data.twoFactorRequired).toBeUndefined();
      // A second run has nothing left to reset.
      expect(run('reset-admin-2fa.ts', good()).status).toBe(2);
    });

    it('works without the encryption key (a lost key must be recoverable)', async () => {
      await enrollAdmin();
      const result = run('reset-admin-2fa.ts', { ...good(), TWO_FACTOR_ENCRYPTION_KEY: '' });
      expect(result.status, output(result)).toBe(0);
    });
  });

  describe('admin:2fa-rekey (key rotation)', () => {
    it('re-seals secrets under the new key, keeps sign-in working, and prints only counts', async () => {
      const { admin, secret } = await enrollAdmin();
      const oldRing = buildKeyring(key(7));
      const before = (await ctx.prisma.adminTwoFactor.findUniqueOrThrow({ where: { userId: admin.userId } }));
      expect(before.keyId).toBe(oldRing.primary.id);

      const dry = run('rekey-2fa.ts', { TWO_FACTOR_ENCRYPTION_KEY: key(9), TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS: key(7), DRY_RUN: '1' });
      expect(dry.status, output(dry)).toBe(0);
      expect(output(dry)).toMatch(/1 need re-sealing/);
      expect((await ctx.prisma.adminTwoFactor.findUniqueOrThrow({ where: { userId: admin.userId } })).secretEnc).toBe(before.secretEnc);

      const result = run('rekey-2fa.ts', { TWO_FACTOR_ENCRYPTION_KEY: key(9), TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS: key(7) });
      expect(result.status, output(result)).toBe(0);
      expect(output(result)).toMatch(/Re-sealed 1 of 1/);
      for (const secretish of [key(7), key(9), secret.toString('hex'), before.secretEnc]) expect(output(result)).not.toContain(secretish);

      const newRing = buildKeyring(key(9));
      const after = await ctx.prisma.adminTwoFactor.findUniqueOrThrow({ where: { userId: admin.userId } });
      expect(after.keyId).toBe(newRing.primary.id);
      expect(after.secretEnc).not.toBe(before.secretEnc);
      expect(openSecret(newRing, admin.userId, after.secretEnc).equals(secret)).toBe(true);
      expect(() => openSecret(oldRing, admin.userId, after.secretEnc)).toThrow();
      expect(await ctx.prisma.auditLog.count({ where: { action: 'admin.2fa.rekey' } })).toBe(1);

      // Idempotent.
      expect(output(run('rekey-2fa.ts', { TWO_FACTOR_ENCRYPTION_KEY: key(9) }))).toMatch(/Re-sealed 0 of 0/);
    });

    it('aborts before writing anything when a secret cannot be opened', async () => {
      const { admin } = await enrollAdmin();
      const before = await ctx.prisma.adminTwoFactor.findUniqueOrThrow({ where: { userId: admin.userId } });
      const result = run('rekey-2fa.ts', { TWO_FACTOR_ENCRYPTION_KEY: key(9) }); // old key not supplied
      expect(result.status).toBe(2);
      expect(output(result)).toMatch(/cannot be opened/);
      expect((await ctx.prisma.adminTwoFactor.findUniqueOrThrow({ where: { userId: admin.userId } })).secretEnc).toBe(before.secretEnc);
      expect(run('rekey-2fa.ts', { TWO_FACTOR_ENCRYPTION_KEY: 'nope' }).status).toBe(2);
      expect(run('rekey-2fa.ts', { TWO_FACTOR_ENCRYPTION_KEY: '' }).status).toBe(2);
    });
  });

  describe('existing admin:update', () => {
    it('also destroys pending second-factor sign-ins', async () => {
      await enrollAdmin();
      await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.adminEmail, password: PASSWORD } });
      expect(await ctx.prisma.adminLoginChallenge.count()).toBe(1);
      const result = run('update-admin.ts', { CURRENT_EMAIL: world.adminEmail, NEW_PASSWORD: 'operator-chosen-pass-5521' });
      expect(result.status, output(result)).toBe(0);
      expect(await ctx.prisma.adminLoginChallenge.count()).toBe(0);
      expect(await ctx.prisma.adminTwoFactor.count()).toBe(1); // 2FA survives a password change
      expect(isWrappedHash((await ctx.prisma.user.findUniqueOrThrow({ where: { email: world.adminEmail } })).passwordHash)).toBe(true);
      expect(await hashPassword('x')).toMatch(/^\$argon2id\$/);
    });
  });
});
