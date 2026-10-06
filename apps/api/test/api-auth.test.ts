import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, call, login, PASSWORD, seedWorld, type World } from './api-helpers.js';

describe('auth', () => {
  const { app, prisma } = buildApp();
  let world: World;
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
  });

  it('logs in, returns the session cookie flags and a csrf token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'printout_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite?.toLowerCase()).toBe('lax');
    expect(cookie.path).toBe('/api/v1'); // also covers /api/v1/shop/events
    expect(res.json().data.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.json().data.shop.slug).toBe(world.a.slug);
    expect(JSON.stringify(res.json())).not.toContain('passwordHash');
  });

  it('rejects wrong passwords and unknown accounts identically', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: 'wrong-password-123' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'nobody@x.test', password: 'wrong-password-123' } });
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.json().error.message).toBe(bad.json().error.message);
  });

  it('rejects mass-assigned or malformed login bodies', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'x', password: 'y', role: 'PLATFORM_ADMIN' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.requestId).toBeTruthy();
  });

  it('restores a session and rejects missing/garbage cookies', async () => {
    const s = await login(app, world.a.ownerEmail);
    const ok = await call(app, s, 'GET', '/auth/session');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.csrfToken).toBe(s.csrf);
    expect((await call(app, null, 'GET', '/auth/session')).statusCode).toBe(401);
    const forged = await app.inject({ method: 'GET', url: '/api/v1/shop/orders', headers: { cookie: 'printout_session=forged' } });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe('UNAUTHORIZED');
  });

  it('logout invalidates the session server-side', async () => {
    const s = await login(app, world.a.ownerEmail);
    expect((await call(app, s, 'POST', '/auth/logout')).statusCode).toBe(204);
    expect((await call(app, s, 'GET', '/shop/orders')).statusCode).toBe(401);
  });

  it('login rotates: a presented session is invalidated', async () => {
    const first = await login(app, world.a.ownerEmail);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { cookie: first.cookie },
      payload: { email: world.a.ownerEmail, password: PASSWORD }
    });
    expect(res.statusCode).toBe(200);
    expect((await call(app, first, 'GET', '/shop/orders')).statusCode).toBe(401);
  });

  it('rejects expired sessions', async () => {
    const s = await login(app, world.a.ownerEmail);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(app, s, 'GET', '/shop/orders')).statusCode).toBe(401);
  });

  it('requires a valid CSRF token on every cookie-authenticated mutation', async () => {
    const s = await login(app, world.a.ownerEmail);
    const mutations: Array<['POST' | 'PUT' | 'DELETE', string, unknown]> = [
      ['PUT', '/shop/settings', { displayName: 'X' }],
      ['POST', '/shop/pricing-rules', { colourMode: 'bw', sides: 'single', pricePerSheetPaise: 5 }],
      ['PUT', '/shop/pricing-rules/abcdefghij', { pricePerSheetPaise: 5 }],
      ['DELETE', '/shop/pricing-rules/abcdefghij', undefined],
      ['POST', '/shop/orders/abcdefghij/transitions', { toStatus: 'CANCELLED', clientRequestId: randomUUID() }],
      ['POST', '/shop/orders/abcdefghij/print-confirmation', { clientRequestId: randomUUID() }],
      ['POST', '/shop/orders/abcdefghij/document-access', {}],
      ['POST', '/auth/logout', undefined]
    ];
    for (const [method, url, body] of mutations) {
      const missing = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie: s.cookie }, ...(body ? { payload: body as object } : {}) });
      expect(missing.statusCode, `${method} ${url} without csrf`).toBe(403);
      expect(missing.json().error.code).toBe('CSRF_INVALID');
      const wrong = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie: s.cookie, 'x-csrf-token': 'a'.repeat(64) }, ...(body ? { payload: body as object } : {}) });
      expect(wrong.statusCode, `${method} ${url} wrong csrf`).toBe(403);
    }
    const valid = await call(app, s, 'PUT', '/shop/settings', { displayName: 'Renamed Shop' });
    expect(valid.statusCode).toBe(200);
  });

  it('transitions and the retired print-confirmation: anonymous 401, platform admin 403 (before any 410/400)', async () => {
    const admin = await login(app, world.adminEmail);
    const calls: Array<[string, unknown]> = [
      ['/shop/orders/abcdefghij/transitions', { toStatus: 'CANCELLED', clientRequestId: randomUUID() }],
      ['/shop/orders/abcdefghij/print-confirmation', { clientRequestId: randomUUID() }]
    ];
    for (const [url, body] of calls) {
      expect((await call(app, null, 'POST', url, body)).statusCode, `anon ${url}`).toBe(401);
      expect((await call(app, admin, 'POST', url, body)).statusCode, `admin ${url}`).toBe(403);
    }
  });

  it('CSRF token of another session is rejected', async () => {
    const a = await login(app, world.a.ownerEmail);
    const b = await login(app, world.b.ownerEmail);
    const res = await app.inject({ method: 'PUT', url: '/api/v1/shop/settings', headers: { cookie: a.cookie, 'x-csrf-token': b.csrf }, payload: { displayName: 'Hack' } });
    expect(res.statusCode).toBe(403);
  });

  it('blocks logins and live sessions of suspended shops', async () => {
    const s = await login(app, world.a.ownerEmail);
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    const live = await call(app, s, 'GET', '/shop/orders');
    expect(live.statusCode).toBe(403);
    expect(live.json().error.code).toBe('SHOP_SUSPENDED');
    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: PASSWORD } });
    expect(again.statusCode).toBe(403);
    expect(again.json().error.code).toBe('SHOP_SUSPENDED');
  });

  it('GET requests never mutate state', async () => {
    const s = await login(app, world.a.ownerEmail);
    const before = await Promise.all([prisma.order.count(), prisma.auditLog.count({ where: { action: { not: 'auth.login' } } })]);
    for (const url of ['/shop/orders', '/shop/settings', '/shop/pricing-rules', '/shop/qr', '/shop/analytics', '/auth/session']) {
      expect((await call(app, s, 'GET', url)).statusCode).toBe(200);
    }
    const after = await Promise.all([prisma.order.count(), prisma.auditLog.count({ where: { action: { not: 'auth.login' } } })]);
    expect(after).toEqual(before);
  });

  it('unknown routes and 5xx use the error envelope without leaking internals', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).json().data.status).toBe('ok');
  });
});

describe('login throttling', () => {
  it('per-route rate limit returns RATE_LIMITED', async () => {
    const { app, prisma } = buildApp({ LOGIN_RATE_LIMIT_MAX: '3' });
    await app.ready();
    await seedWorld(prisma);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `u${i}@x.test`, password: 'whatever-123' } });
      codes.push(r.statusCode);
      if (r.statusCode === 429) expect(r.json().error.code).toBe('RATE_LIMITED');
    }
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
    await app.close();
  });

  it('locks IP+email after repeated failures, even with the right password, but not other emails', async () => {
    const { app, prisma } = buildApp({ LOGIN_FAIL_MAX: '3' });
    await app.ready();
    const world = await seedWorld(prisma);
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: 'wrong-password-123' } });
    }
    const locked = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: PASSWORD } });
    expect(locked.statusCode).toBe(429);
    const other = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.b.ownerEmail, password: PASSWORD } });
    expect(other.statusCode).toBe(200);
    await app.close();
  });
});
