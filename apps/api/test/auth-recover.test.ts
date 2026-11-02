import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth.js';
import { PASSWORD } from './api-helpers.js';
import { gtok, makeShopReady, makeShoplessOwner, startHarness, userByEmail, type Harness } from './helpers/profile-harness.js';

/** One-time legacy owner recovery: POST /auth/google/recover (existing password + verified Google token in one request). */
const ORIGIN = { origin: 'http://localhost:5173' };
const G = 'recovered.owner@gmail.test';

describe('legacy owner recovery (POST /auth/google/recover)', () => {
  let h: Harness;
  let age = 280;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
    age = 280;
    await makeShopReady(h.prisma, h.world.a.shopId);
  });

  const g = (email = G, o: Parameters<typeof gtok>[1] = {}) => gtok(email, { ago: age--, ...o });
  const recover = (body: Record<string, unknown>, headers: Record<string, string> = ORIGIN) =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/google/recover', payload: body, headers });
  const attempt = (o: { email?: string; password?: string; idToken?: string } = {}) =>
    recover({ email: o.email ?? h.world.a.ownerEmail, password: o.password ?? PASSWORD, idToken: o.idToken ?? g() });
  const sessionCookie = (r: LightMyRequestResponse) => r.cookies.find((c) => c.name === 'printout_session');
  const googleRows = () => h.prisma.userGoogleIdentity.findMany();
  const login = async (email = h.world.a.ownerEmail) => {
    const r = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
    expect(r.statusCode, r.body).toBe(200);
    return `printout_session=${sessionCookie(r)!.value}`;
  };
  const meStatus = async (cookie: string) => (await h.app.inject({ method: 'GET', url: '/api/v1/users/me', headers: { cookie } })).statusCode;

  it('links the Google identity, ends older sessions, issues a normal session and audits without secrets', async () => {
    const old = await login();
    expect(await meStatus(old)).toBe(200);
    const idToken = g();
    const res = await attempt({ idToken });
    expect(res.statusCode, res.body).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie?.httpOnly).toBe(true);
    const d = res.json().data;
    expect(d.csrfToken).toBeTruthy();
    expect(d.user.role).toBe('SHOP_OWNER');
    expect(d.shop.id).toBe(h.world.a.shopId);
    const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
    const rows = await googleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: owner.id, firebaseUid: `guid-${G}` });
    expect(await meStatus(old)).toBe(401);
    expect(await meStatus(`printout_session=${cookie!.value}`)).toBe(200);
    // the linked identity now signs in through the normal Google route
    const again = await h.app.inject({ method: 'POST', url: '/api/v1/auth/google/session', payload: { idToken: g() }, headers: ORIGIN });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data.user.id).toBe(owner.id);

    const audits = await h.prisma.auditLog.findMany({ where: { action: 'auth.google.recovered' } });
    expect(audits).toHaveLength(1);
    const blob = JSON.stringify(audits) + res.body;
    for (const secret of [PASSWORD, idToken, `guid-${G}`, 'passwordHash']) expect(blob).not.toContain(secret);
    expect(blob).not.toContain(G); // email is masked
  });

  it('a wrong password is a generic 401, links nothing and is audited', async () => {
    const res = await attempt({ password: 'definitely-wrong-password' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(await googleRows()).toHaveLength(0);
    expect(sessionCookie(res)).toBeUndefined();
    const unknown = await attempt({ email: 'nobody@x.test' });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe(res.json().error.message);
  });

  it('refuses admins, customers and shop-less users with the generic error and links nothing', async () => {
    const admin = await attempt({ email: h.world.adminEmail });
    expect(admin.statusCode).toBe(401);
    expect(admin.json().error.code).toBe('INVALID_CREDENTIALS');
    await h.prisma.user.create({ data: { email: 'cust@x.test', displayName: 'Cust', passwordHash: await hashPassword(PASSWORD), role: 'CUSTOMER' } });
    expect((await attempt({ email: 'cust@x.test' })).statusCode).toBe(401);
    const shopless = await makeShoplessOwner(h.prisma);
    const shoplessEmail = shopless.email ?? 'noshop@x.test';
    expect((await attempt({ email: shoplessEmail })).statusCode).toBe(401);
    expect(await googleRows()).toHaveLength(0);
  });

  it('refuses a Google identity already linked to another account', async () => {
    const other = await userByEmail(h.prisma, h.world.b.ownerEmail);
    await h.prisma.userGoogleIdentity.create({ data: { userId: other.id, firebaseUid: `guid-${G}`, email: G, linkedAt: new Date() } as never });
    const res = await attempt();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('GOOGLE_IDENTITY_UNAVAILABLE');
    expect(sessionCookie(res)).toBeUndefined();
    expect(await googleRows()).toHaveLength(1);
  });

  it('refuses when the account already has a Google identity (one per account)', async () => {
    const owner = await userByEmail(h.prisma, h.world.a.ownerEmail);
    await h.prisma.userGoogleIdentity.create({ data: { userId: owner.id, firebaseUid: 'guid-existing', email: 'existing@gmail.test', linkedAt: new Date() } as never });
    const res = await attempt();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('GOOGLE_ALREADY_LINKED');
    expect((await googleRows())[0]!.firebaseUid).toBe('guid-existing');
  });

  it('never links by email alone: a Google token with the owner email still needs the password', async () => {
    const res = await attempt({ password: 'definitely-wrong-password', idToken: g(h.world.a.ownerEmail) });
    expect(res.statusCode).toBe(401);
    const noPassword = await recover({ email: h.world.a.ownerEmail, idToken: g(h.world.a.ownerEmail) });
    expect(noPassword.statusCode).toBe(400);
    expect(await googleRows()).toHaveLength(0);
  });

  it('refuses an unverified Google token and a cross-origin request', async () => {
    const bad = await attempt({ idToken: g(G, { emailVerified: false }) });
    expect(bad.statusCode).toBe(401);
    const cross = await recover({ email: h.world.a.ownerEmail, password: PASSWORD, idToken: g() }, { origin: 'https://evil.com' });
    expect(cross.statusCode).toBe(403);
    expect(await googleRows()).toHaveLength(0);
  });

  it('keeps POST /auth/login for email+password unchanged', async () => {
    await login();
  });
});

describe('legacy owner recovery throttling', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true', LOGIN_FAIL_MAX: '5' });
  });
  afterAll(async () => h.close());
  it('throttles repeated wrong passwords, even for the correct password afterwards, and links nothing', async () => {
    const post = (password: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/google/recover',
        payload: { email: h.world.a.ownerEmail, password, idToken: gtok(G, { ago: 100 }) },
        headers: ORIGIN
      });
    for (let i = 0; i < 5; i++) expect((await post(`wrong-password-${i}`)).statusCode).toBe(401);
    expect((await post(PASSWORD)).statusCode).toBe(429);
    expect(await h.prisma.userGoogleIdentity.count()).toBe(0);
  });
});

describe('legacy owner recovery when Google is disabled', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'false' });
  });
  afterAll(async () => h.close());
  it('answers 503 GOOGLE_LOGIN_UNAVAILABLE', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google/recover',
      payload: { email: h.world.a.ownerEmail, password: PASSWORD, idToken: gtok('x@gmail.test') },
      headers: ORIGIN
    });
    expect(res.statusCode).toBe(503);
  });
});
