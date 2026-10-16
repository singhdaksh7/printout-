import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { buildApp, call, login, PASSWORD, seedWorld, testConfig, type World } from './api-helpers.js';

const NEW_PASSWORD = 'a-brand-new-long-passphrase-42';
const NEW_EMAIL = 'renamed-admin@x.test';

describe('admin account self-service', () => {
  const ctx = buildApp();
  let world: World;
  beforeAll(async () => ctx.app.ready());
  afterAll(async () => ctx.app.close());
  beforeEach(async () => {
    world = await seedWorld(ctx.prisma);
  });

  const asAdmin = () => login(ctx.app, world.adminEmail);
  const adminUser = () => ctx.prisma.user.findUniqueOrThrow({ where: { email: world.adminEmail } });
  const activeSessions = (userId: string) => ctx.prisma.session.count({ where: { userId, invalidatedAt: null } });

  describe('GET /admin/account', () => {
    it('returns the own profile and session metadata, with no secrets', async () => {
      const admin = await asAdmin();
      await asAdmin(); // a second device
      const res = await call(ctx.app, admin, 'GET', '/admin/account');
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const data = res.json().data;
      expect(data).toMatchObject({ email: world.adminEmail, role: 'PLATFORM_ADMIN', displayName: 'Admin' });
      expect(data.session.otherActiveSessions).toBe(1);
      expect(Object.keys(data).sort()).toEqual(['createdAt', 'displayName', 'email', 'id', 'role', 'session']);
      const raw = res.body;
      expect(raw).not.toMatch(/passwordHash|argon2|tokenHash|csrf/i);
    });

    it('requires an authenticated platform admin', async () => {
      expect((await call(ctx.app, null, 'GET', '/admin/account')).statusCode).toBe(401);
      const owner = await login(ctx.app, world.a.ownerEmail);
      expect((await call(ctx.app, owner, 'GET', '/admin/account')).statusCode).toBe(403);
    });
  });

  describe('POST /admin/account/password', () => {
    it('changes the password with the correct current password, ends every session and audits metadata only', async () => {
      const admin = await asAdmin();
      const other = await asAdmin();
      const res = await call(ctx.app, admin, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ signedOut: true });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['set-cookie']).toMatch(/printout_session=;/);
      expect(res.body).not.toContain(NEW_PASSWORD);

      const user = await adminUser();
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(await verifyPassword(user.passwordHash, NEW_PASSWORD)).toBe(true);
      expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(false);
      expect(await activeSessions(user.id)).toBe(0);
      // Both the calling session and the other device are dead.
      expect((await call(ctx.app, admin, 'GET', '/admin/account')).statusCode).toBe(401);
      expect((await call(ctx.app, other, 'GET', '/admin/account')).statusCode).toBe(401);
      // Old password no longer signs in; the new one does.
      expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.adminEmail, password: PASSWORD } })).statusCode).toBe(401);
      await login(ctx.app, world.adminEmail, NEW_PASSWORD);

      const rows = await ctx.prisma.auditLog.findMany({ where: { action: 'admin.account.password_changed' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: user.id, actorType: 'PLATFORM_ADMIN', targetId: user.id, shopId: null });
      expect(rows[0]!.metadata).toEqual({ sessionsEnded: 2 });
    });

    it('rejects a wrong current password without changing anything and audits the failed attempt', async () => {
      const admin = await asAdmin();
      const before = await adminUser();
      const res = await call(ctx.app, admin, 'POST', '/admin/account/password', { currentPassword: 'not-the-password-1', newPassword: NEW_PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INVALID_CURRENT_PASSWORD');
      expect((await adminUser()).passwordHash).toBe(before.passwordHash);
      expect(await activeSessions(before.id)).toBe(1);
      expect((await call(ctx.app, admin, 'GET', '/admin/account')).statusCode).toBe(200);
      const failed = await ctx.prisma.auditLog.findMany({ where: { action: 'admin.account.reauth_failed' } });
      expect(failed).toHaveLength(1);
      expect(failed[0]!.metadata).toEqual({ operation: 'password' });
      expect(JSON.stringify(failed)).not.toContain('not-the-password-1');
    });

    it.each([
      ['too short', 'Short1!'],
      ['a placeholder', 'please-change-this-password'],
      ['repetitive', 'aaaaaaaaaaaaaaaa'],
      ['a common password', 'password12345'],
      ['containing the email name', 'my-admin-account-pass']
    ])('enforces the password policy: %s', async (_name, newPassword) => {
      const admin = await asAdmin();
      const before = await adminUser();
      const res = await call(ctx.app, admin, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(res.body).not.toContain(newPassword);
      expect((await adminUser()).passwordHash).toBe(before.passwordHash);
      expect(await activeSessions(before.id)).toBe(1);
    });

    it('rejects reusing the current password and unknown or oversized fields', async () => {
      const admin = await asAdmin();
      const reuse = await call(ctx.app, admin, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: PASSWORD });
      expect(reuse.statusCode).toBe(400);
      for (const body of [
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, userId: 'someone-else' },
        { currentPassword: PASSWORD },
        { currentPassword: PASSWORD, newPassword: 'x'.repeat(257) }
      ]) {
        expect((await call(ctx.app, admin, 'POST', '/admin/account/password', body)).statusCode).toBe(400);
      }
    });

    it('rejects a missing or wrong CSRF token', async () => {
      const admin = await asAdmin();
      const res = await call(ctx.app, { ...admin, csrf: 'nope' }, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_INVALID');
    });

    it('rejects shop owners and anonymous callers, and never touches the owner account', async () => {
      const owner = await login(ctx.app, world.a.ownerEmail);
      const before = await ctx.prisma.user.findUniqueOrThrow({ where: { email: world.a.ownerEmail } });
      const res = await call(ctx.app, owner, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(res.statusCode).toBe(403);
      expect((await call(ctx.app, null, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).statusCode).toBe(401);
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { email: world.a.ownerEmail } })).passwordHash).toBe(before.passwordHash);
      expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: 'admin.account' } } })).toBe(0);
    });

    it("only changes the caller's own account, never another admin's", async () => {
      await ctx.prisma.user.create({ data: { email: 'second-admin@x.test', displayName: 'Second', passwordHash: await hashPassword(PASSWORD), role: 'PLATFORM_ADMIN' } });
      const second = await login(ctx.app, 'second-admin@x.test');
      const admin = await asAdmin();
      await call(ctx.app, admin, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      const other = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'second-admin@x.test' } });
      expect(await verifyPassword(other.passwordHash, PASSWORD)).toBe(true);
      expect((await call(ctx.app, second, 'GET', '/admin/account')).statusCode).toBe(200);
    });

    it('rolls back the credential change and keeps the sessions when the audit write fails', async () => {
      const admin = await asAdmin();
      const before = await adminUser();
      await ctx.prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$ LANGUAGE plpgsql`);
      await ctx.prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW.action = 'admin.account.password_changed') EXECUTE FUNCTION test_fail_audit()`);
      try {
        const res = await call(ctx.app, admin, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toMatch(/audit unavailable|argon2/i);
      } finally {
        await ctx.prisma.$executeRawUnsafe(`DROP TRIGGER test_fail_audit ON "AuditLog"`);
        await ctx.prisma.$executeRawUnsafe(`DROP FUNCTION test_fail_audit()`);
      }
      expect((await adminUser()).passwordHash).toBe(before.passwordHash);
      expect(await activeSessions(before.id)).toBe(1);
      expect((await call(ctx.app, admin, 'GET', '/admin/account')).statusCode).toBe(200);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'admin.account.password_changed' } })).toBe(0);
    });

    it('lets only one of two concurrent changes win', async () => {
      const a = await asAdmin();
      const b = await asAdmin();
      const [r1, r2] = await Promise.all([
        call(ctx.app, a, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
        call(ctx.app, b, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: 'another-valid-passphrase-77' })
      ]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'admin.account.password_changed' } })).toBe(1);
    });
  });

  describe('POST /admin/account/email', () => {
    it('changes the email (normalised), ends every session and audits without the addresses', async () => {
      const admin = await asAdmin();
      const res = await call(ctx.app, admin, 'POST', '/admin/account/email', { currentPassword: PASSWORD, newEmail: `  ${NEW_EMAIL.toUpperCase()} ` });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ email: NEW_EMAIL, signedOut: true });
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: NEW_EMAIL } });
      expect(user.role).toBe('PLATFORM_ADMIN');
      expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(true);
      expect(await activeSessions(user.id)).toBe(0);
      expect((await call(ctx.app, admin, 'GET', '/admin/account')).statusCode).toBe(401);
      await login(ctx.app, NEW_EMAIL);
      const rows = await ctx.prisma.auditLog.findMany({ where: { action: 'admin.account.email_changed' } });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(NEW_EMAIL);
      expect(JSON.stringify(rows[0])).not.toContain(world.adminEmail);
    });

    it('rejects a wrong current password', async () => {
      const admin = await asAdmin();
      const res = await call(ctx.app, admin, 'POST', '/admin/account/email', { currentPassword: 'wrong-wrong-wrong', newEmail: NEW_EMAIL });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INVALID_CURRENT_PASSWORD');
      expect(await ctx.prisma.user.count({ where: { email: NEW_EMAIL } })).toBe(0);
    });

    it('rejects a duplicate email with a generic answer that is identical for shop owners and admins, and changes nothing', async () => {
      const admin = await asAdmin();
      const taken = await call(ctx.app, admin, 'POST', '/admin/account/email', { currentPassword: PASSWORD, newEmail: world.a.ownerEmail });
      expect(taken.statusCode).toBe(409);
      expect(taken.json().error.code).toBe('EMAIL_UNAVAILABLE');
      expect(taken.body).not.toContain(world.a.ownerEmail);
      expect(await activeSessions((await adminUser()).id)).toBe(1);
      // Case-insensitive collision with the same wording.
      const upper = await call(ctx.app, admin, 'POST', '/admin/account/email', { currentPassword: PASSWORD, newEmail: world.a.ownerEmail.toUpperCase() });
      expect(upper.statusCode).toBe(409);
      expect(upper.json().error.message).toBe(taken.json().error.message);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'admin.account.email_changed' } })).toBe(0);
    });

    it('surfaces a database-level unique race as the same generic conflict', async () => {
      const admin = await asAdmin();
      // The pre-check passes, then another user takes the address before the update: simulate with a trigger-free double insert.
      const [r1] = await Promise.all([
        call(ctx.app, admin, 'POST', '/admin/account/email', { currentPassword: PASSWORD, newEmail: NEW_EMAIL }),
        ctx.prisma.user.create({ data: { email: NEW_EMAIL, displayName: 'Racer', passwordHash: await hashPassword(PASSWORD), role: 'SHOP_OWNER', shopId: world.b.shopId } }).catch(() => undefined)
      ]);
      expect([200, 409]).toContain(r1.statusCode);
      expect(await ctx.prisma.user.count({ where: { email: NEW_EMAIL } })).toBe(1);
    });

    it('validates the new email and rejects an unchanged one', async () => {
      const admin = await asAdmin();
      for (const newEmail of ['not-an-email', '', `${'a'.repeat(250)}@x.test`]) {
        expect((await call(ctx.app, admin, 'POST', '/admin/account/email', { currentPassword: PASSWORD, newEmail })).statusCode).toBe(400);
      }
      const same = await call(ctx.app, admin, 'POST', '/admin/account/email', { currentPassword: PASSWORD, newEmail: world.adminEmail });
      expect(same.statusCode).toBe(400);
      expect(same.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects shop owners and anonymous callers', async () => {
      const owner = await login(ctx.app, world.a.ownerEmail);
      expect((await call(ctx.app, owner, 'POST', '/admin/account/email', { currentPassword: PASSWORD, newEmail: NEW_EMAIL })).statusCode).toBe(403);
      expect((await call(ctx.app, null, 'POST', '/admin/account/email', { currentPassword: PASSWORD, newEmail: NEW_EMAIL })).statusCode).toBe(401);
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { email: world.a.ownerEmail } })).role).toBe('SHOP_OWNER');
    });

    it('rolls back when the audit write fails', async () => {
      const admin = await asAdmin();
      await ctx.prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$ LANGUAGE plpgsql`);
      await ctx.prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW.action = 'admin.account.email_changed') EXECUTE FUNCTION test_fail_audit()`);
      try {
        expect((await call(ctx.app, admin, 'POST', '/admin/account/email', { currentPassword: PASSWORD, newEmail: NEW_EMAIL })).statusCode).toBe(500);
      } finally {
        await ctx.prisma.$executeRawUnsafe(`DROP TRIGGER test_fail_audit ON "AuditLog"`);
        await ctx.prisma.$executeRawUnsafe(`DROP FUNCTION test_fail_audit()`);
      }
      expect((await adminUser()).email).toBe(world.adminEmail);
      expect((await call(ctx.app, admin, 'GET', '/admin/account')).statusCode).toBe(200);
    });
  });

  describe('abuse controls', () => {
    it('throttles repeated wrong current-password attempts per admin, even with the right password afterwards', async () => {
      const limited = buildApp({ LOGIN_FAIL_MAX: '3' });
      await limited.app.ready();
      try {
        const admin = await login(limited.app, world.adminEmail);
        for (let i = 0; i < 3; i++) {
          const r = await call(limited.app, admin, 'POST', '/admin/account/password', { currentPassword: `wrong-attempt-${i}-xx`, newPassword: NEW_PASSWORD });
          expect(r.statusCode).toBe(403);
        }
        const blocked = await call(limited.app, admin, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json().error.code).toBe('RATE_LIMITED');
        expect(await verifyPassword((await adminUser()).passwordHash, PASSWORD)).toBe(true);
      } finally {
        await limited.app.close();
      }
    });

    it('applies the admin mutation rate limit', async () => {
      const limited = buildApp({ RATE_LIMIT_ADMIN_MUTATION_MAX: '2', LOGIN_FAIL_MAX: '1000' });
      await limited.app.ready();
      try {
        const admin = await login(limited.app, world.adminEmail);
        const codes: number[] = [];
        for (let i = 0; i < 4; i++) codes.push((await call(limited.app, admin, 'POST', '/admin/account/email', { currentPassword: 'wrong-wrong-wrong', newEmail: NEW_EMAIL })).statusCode);
        expect(codes).toEqual([403, 403, 429, 429]);
      } finally {
        await limited.app.close();
      }
    });
  });

  it('does not log passwords, even on rejected requests', async () => {
    const lines: string[] = [];
    const app = createApp({
      config: testConfig({ NODE_ENV: 'development' }),
      prisma: ctx.prisma,
      logStream: new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) })
    }).app;
    await app.ready();
    try {
      const admin = await login(app, world.adminEmail);
      await call(app, admin, 'POST', '/admin/account/password', { currentPassword: 'wrong-wrong-wrong', newPassword: NEW_PASSWORD });
      await call(app, admin, 'POST', '/admin/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    } finally {
      await app.close();
    }
    const all = lines.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [PASSWORD, NEW_PASSWORD, 'wrong-wrong-wrong']) expect(all).not.toContain(secret);
  });
});

describe('admin:update CLI still works (maintenance path)', () => {
  const prisma = buildApp().prisma;
  const apiDir = path.resolve(__dirname, '..');
  const run = (env: Record<string, string>) =>
    spawnSync('node', ['--import', 'tsx', 'prisma/update-admin.ts'], {
      cwd: apiDir,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000
    });

  it('updates email and password, ends sessions, audits, and never prints the password', async () => {
    const world = await seedWorld(prisma);
    const app = buildApp().app;
    await app.ready();
    const admin = await login(app, world.adminEmail);
    const result = run({ DATABASE_URL: process.env.DATABASE_URL!, CURRENT_EMAIL: world.adminEmail, NEW_EMAIL: 'cli-admin@x.test', NEW_PASSWORD: 'cli-set-passphrase-9981' });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('cli-set-passphrase-9981');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'cli-admin@x.test' } });
    expect(await verifyPassword(user.passwordHash, 'cli-set-passphrase-9981')).toBe(true);
    expect((await call(app, admin, 'GET', '/admin/account')).statusCode).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'admin.credentials.update', targetId: user.id } })).toBe(1);
    await app.close();
  });

  it('refuses non-admins, duplicate emails and weak passwords with exit code 2', async () => {
    const world = await seedWorld(prisma);
    const base = { DATABASE_URL: process.env.DATABASE_URL! };
    expect(run({ ...base, CURRENT_EMAIL: world.a.ownerEmail, NEW_PASSWORD: 'long-enough-passphrase-1' }).status).toBe(2);
    expect(run({ ...base, CURRENT_EMAIL: world.adminEmail, NEW_EMAIL: world.a.ownerEmail }).status).toBe(2);
    expect(run({ ...base, CURRENT_EMAIL: world.adminEmail, NEW_PASSWORD: 'short' }).status).toBe(2);
    expect(run({ CURRENT_EMAIL: world.adminEmail, NEW_PASSWORD: 'long-enough-passphrase-1', DATABASE_URL: '' }).status).toBe(2);
  });
});
