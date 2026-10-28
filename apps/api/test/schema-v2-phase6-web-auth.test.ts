import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cookieAuth, cookieOf, gtok, grantAuthFrom, req, startHarness, type Harness } from './helpers/profile-harness.js';

/** Schema-v2 phase 6: cookie-based Google sign-in for marketplace customers on the web (POST /auth/customer/google/session). */
const ORIGIN = { origin: 'http://localhost:5173' };

describe('web customer Google sign-in', () => {
  let h: Harness;
  let age = 280;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true', CUSTOMER_SIGNUP_ENABLED: 'true' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reseed();
    age = 280;
  });

  const data = (r: LightMyRequestResponse) => r.json().data as Record<string, any>;
  const signIn = (email: string, uid?: string, headers: Record<string, string> = ORIGIN, token?: string) =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/customer/google/session', headers, payload: { idToken: token ?? gtok(email, { ago: age--, ...(uid ? { uid } : {}) }) } });

  async function register(email = 'web@cust.test', uid = 'guid-web-1') {
    const first = await signIn(email, uid);
    expect(first.statusCode, first.body).toBe(200);
    expect(data(first)).toMatchObject({ nextStep: 'create_customer', session: null, shops: [] });
    const grant = grantAuthFrom(first);
    const created = await req(h.app, grant, 'POST', '/customers/onboarding', { name: 'Web Customer', client: 'web' }, ORIGIN);
    expect(created.statusCode, created.body).toBe(201);
    return created;
  }

  it('registers through the restricted cookie, then holds a cookie session with CSRF', async () => {
    const created = await register();
    const session = cookieOf(created, 'printout_session');
    expect(session).toBeTruthy();
    expect(data(created)).toMatchObject({ nextStep: 'customer_home', user: { role: 'customer', email: 'web@cust.test' }, session: { transport: 'cookie' } });
    const auth = cookieAuth(`printout_session=${session!.value}`, data(created).csrfToken);
    const me = await req(h.app, auth, 'GET', '/customers/me');
    expect(me.statusCode, me.body).toBe(200);
    // cookie mutations need the CSRF header
    const noCsrf = await h.app.inject({ method: 'PATCH', url: '/api/v1/customers/me', headers: { cookie: `printout_session=${session!.value}` }, payload: { name: 'X' } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await req(h.app, auth, 'PATCH', '/customers/me', { name: 'Renamed' })).statusCode).toBe(200);
  });

  it('signs in again with the same identity and a fresh token; a replayed token is refused', async () => {
    await register('again@cust.test', 'guid-web-2');
    const token = gtok('again@cust.test', { ago: age--, uid: 'guid-web-2' });
    const ok = await signIn('', undefined, ORIGIN, token);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(data(ok)).toMatchObject({ nextStep: 'customer_home', user: { role: 'customer' } });
    expect(cookieOf(ok, 'printout_session')).toBeTruthy();
    const replay = await signIn('', undefined, ORIGIN, token);
    expect(replay.statusCode).toBe(401);
  });

  it('refuses cross-origin requests, other roles and blocked accounts', async () => {
    expect((await signIn('x@cust.test', undefined, { origin: 'https://evil.example' })).statusCode).toBe(403);
    const owner = await h.prisma.user.findUniqueOrThrow({ where: { email: h.world.a.ownerEmail } });
    await h.prisma.userGoogleIdentity.create({ data: { userId: owner.id, firebaseUid: 'guid-owner-x', email: h.world.a.ownerEmail } });
    const asOwner = await signIn(h.world.a.ownerEmail, 'guid-owner-x');
    expect(asOwner.statusCode).toBe(403);
    expect(cookieOf(asOwner, 'printout_session')).toBeFalsy();
    await register('blocked@cust.test', 'guid-web-3');
    await h.prisma.user.updateMany({ where: { role: 'CUSTOMER' }, data: { isActive: false } });
    const blocked = await signIn('blocked@cust.test', 'guid-web-3');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('ACCOUNT_BLOCKED');
  });

  it('never links by matching email: an owner-lookalike Google account becomes its own customer without an email', async () => {
    const created = await register(h.world.a.ownerEmail, 'guid-lookalike');
    expect(data(created).user).toMatchObject({ role: 'customer', email: null });
    expect((await h.prisma.user.findUniqueOrThrow({ where: { email: h.world.a.ownerEmail } })).role).toBe('SHOP_OWNER');
  });

  it('registration stays closed while CUSTOMER_SIGNUP_ENABLED is off', async () => {
    const off = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true', CUSTOMER_SIGNUP_ENABLED: '__unset__' });
    try {
      const first = await off.app.inject({ method: 'POST', url: '/api/v1/auth/customer/google/session', headers: ORIGIN, payload: { idToken: gtok('closed@cust.test', { ago: 100 }) } });
      expect(first.statusCode).toBe(200);
      const res = await req(off.app, grantAuthFrom(first), 'POST', '/customers/onboarding', { name: 'Closed', client: 'web' }, ORIGIN);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CUSTOMER_SIGNUP_DISABLED');
      expect(await off.prisma.user.count({ where: { role: 'CUSTOMER' } })).toBe(0);
    } finally {
      await off.close();
    }
  });
});
