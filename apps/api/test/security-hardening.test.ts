import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testPrisma } from './helpers/db.js';
import { baseOptions, buildApp, call, createDocument, login, PASSWORD, quoteFor, seedWorld, testConfig, type World } from './api-helpers.js';

const prisma = testPrisma();
let world: World;
let app: FastifyInstance | undefined;

beforeEach(async () => {
  world = await seedWorld(prisma);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('SEC: price arithmetic', () => {
  it('rejects a quote whose total would overflow the INT column instead of failing later with a 500', async () => {
    ({ app } = buildApp());
    await prisma.pricingRule.updateMany({ where: { shopId: world.a.shopId }, data: { pricePerSheetPaise: 1_000_000 } });
    const doc = await createDocument(prisma, world.a.shopId, { pageCount: 200 });
    const res = await quoteFor(app, world.a.slug, doc.id, { ...baseOptions, copies: 1000 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('still prices large-but-sane orders', async () => {
    ({ app } = buildApp());
    const doc = await createDocument(prisma, world.a.shopId, { pageCount: 200 });
    const res = await quoteFor(app, world.a.slug, doc.id, { ...baseOptions, copies: 1000 });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.totalPaise).toBe(200 * 1000 * 200);
  });
});

describe('SEC: secrets never reach the request log', () => {
  it('does not log query strings (signed document URLs, upload tokens)', async () => {
    let logged = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logged += chunk.toString();
        cb();
      }
    });
    const built = createApp({ config: testConfig({ NODE_ENV: 'development' }), prisma, logStream: stream });
    app = built.app;
    await app.inject({ method: 'GET', url: `/api/v1/internal/documents/${'a'.repeat(30)}?exp=9999999999&sig=SECRETSIGNATURE123` });
    await app.inject({ method: 'PUT', url: '/api/v1/public/uploads/abcdefghij/content?token=SECRETUPLOADTOKEN456', payload: 'x' });
    await app.inject({ method: 'GET', url: '/api/v1/public/orders/TRACKINGSECRET789?x=1' });
    expect(logged).toContain('incoming request');
    expect(logged).not.toContain('SECRETSIGNATURE123');
    expect(logged).not.toContain('SECRETUPLOADTOKEN456');
    // The tracking token is a bearer credential in the PATH; it must not be logged either.
    expect(logged).not.toContain('TRACKINGSECRET789');
  });
});

describe('SEC: login throttling cannot be bypassed by spoofing X-Forwarded-For', () => {
  it('blocks an account after repeated failures from rotating forged client IPs', async () => {
    ({ app } = buildApp({ TRUST_PROXY: 'true', LOGIN_FAIL_MAX: '3' }));
    const attempt = (i: number, password: string) =>
      app!.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': `10.1.${Math.floor(i / 200)}.${i % 200}` },
        payload: { email: world.a.ownerEmail, password }
      });
    for (let i = 0; i < 20; i++) expect([401, 429]).toContain((await attempt(i, 'wrong-password-123')).statusCode);
    const res = await attempt(99, PASSWORD);
    expect(res.statusCode).toBe(429);
  });

  it('TRUST_PROXY_CIDRS trusts only listed proxies, ignoring the client-forged left side of X-Forwarded-For', async () => {
    const built = buildApp({ TRUST_PROXY_CIDRS: '127.0.0.1' });
    app = built.app;
    app.get('/_ip', async (request) => ({ ip: request.ip }));
    const res = await app.inject({ method: 'GET', url: '/_ip', headers: { 'x-forwarded-for': '6.6.6.6, 9.9.9.9' } });
    expect(res.json().ip).toBe('9.9.9.9');
  });
});

describe('SEC: connection hardening', () => {
  it('has a finite request timeout (slow-body clients cannot hold sockets forever)', () => {
    ({ app } = buildApp());
    expect(app.server.requestTimeout).toBeGreaterThan(0);
  });

  it('does not buffer-and-parse JSON/text bodies on the raw upload route', async () => {
    ({ app } = buildApp());
    const init = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shops/${world.a.slug}/uploads/initiate`,
      payload: { fileName: 'a.pdf', byteSize: 5_000_000, declaredMimeType: 'application/pdf' }
    });
    const { uploadUrl } = init.json().data;
    const bigJson = JSON.stringify({ pad: 'x'.repeat(2_000_000) });
    for (const type of ['application/json', 'text/plain']) {
      const res = await app.inject({ method: 'PUT', url: uploadUrl, payload: bigJson, headers: { 'content-type': type } });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe('INVALID_FILE_TYPE');
    }
  });

  it('upload ids are unguessable (not sequential cuids)', async () => {
    ({ app } = buildApp());
    const init = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shops/${world.a.slug}/uploads/initiate`,
      payload: { fileName: 'a.pdf', byteSize: 100, declaredMimeType: 'application/pdf' }
    });
    const id: string = init.json().data.uploadId;
    expect(id).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(id).not.toMatch(/^c[a-z0-9]{24}$/);
  });

  it('authenticated and tracking JSON responses are never cacheable', async () => {
    ({ app } = buildApp());
    const s = await login(app, world.a.ownerEmail);
    const res = await call(app, s, 'GET', '/shop/orders');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const pub = await app.inject({ method: 'GET', url: '/api/v1/public/orders/nope-nope-nope' });
    expect(pub.headers['cache-control']).toMatch(/no-store/);
  });
});

describe('SEC: production behaviour (regression probes)', () => {
  const prodConfig = () =>
    testConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'p'.repeat(20) + 'Zq8vK2mXw9LrT4bN7cYd',
      CSRF_SECRET: 'c'.repeat(20) + 'Hj3sF6gUe1PaV5oRt0Ik',
      WEB_ORIGIN: 'https://print.example.org',
      DATABASE_URL: 'postgresql://printout:s3cure-pw@localhost:55433/printout_test_sec'
    });

  it('sets hardened cookie flags and never leaks internals on 500', async () => {
    const built = createApp({ config: prodConfig(), prisma });
    app = built.app;
    app.get('/_boom', async () => {
      throw Object.assign(new Error('relation "User" does not exist at /srv/app/src/secret.ts'), { code: 'P2021', meta: { table: 'User' } });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: world.a.ownerEmail, password: PASSWORD }
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.headers['set-cookie'] as string;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=(Lax|Strict)/i);
    expect(cookie).toMatch(/Path=\/api\/v1/);
    expect(res.headers['strict-transport-security']).toBeDefined();
    const boom = await app.inject({ method: 'GET', url: '/_boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toMatch(/secret\.ts|P2021|relation|stack|at /);
    expect(boom.json().error.code).toBe('INTERNAL_ERROR');
  });

  it('CORS: never reflects a foreign origin; credentials only for the configured one', async () => {
    ({ app } = buildApp());
    const evil = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' }
    });
    expect(evil.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    expect(evil.headers['access-control-allow-origin']).not.toBe('*');
    const good = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' }
    });
    expect(good.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(good.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('SEC: tenant probes (regression)', () => {
  it('forged shopId in bodies/queries is rejected or ignored; foreign ids are 404', async () => {
    ({ app } = buildApp());
    const b = await login(app, world.b.ownerEmail);
    const res = await call(app, b, 'POST', '/shop/pricing-rules', {
      colourMode: 'bw', sides: 'single', pricePerSheetPaise: 5, shopId: world.a.shopId
    });
    expect(res.statusCode).toBe(400);
    const list = await call(app, b, 'GET', `/shop/orders?shopId=${world.a.shopId}`);
    expect(list.statusCode).toBe(400);
    const foreign = await call(app, b, 'GET', `/shop/orders/${randomUUID()}`);
    expect(foreign.statusCode).toBe(404);
  });

  it('responses never contain storage keys, hashes or other orders tracking tokens', async () => {
    ({ app } = buildApp());
    const server = app;
    const { newOrder } = await import('./api-helpers.js');
    const o = await newOrder(server, prisma, world.a);
    const a = await login(server, world.a.ownerEmail);
    for (const url of ['/shop/orders', `/shop/orders/${o.order.id}`, '/shop/analytics', '/auth/session']) {
      const body = (await call(server, a, 'GET', url)).body;
      expect(body).not.toMatch(/objectKey|passwordHash|tokenHash|trackingToken|test-[0-9a-f-]{36}/);
    }
    const access = await call(server, a, 'POST', `/shop/orders/${o.order.id}/document-access`, {});
    expect(access.body).not.toMatch(/objectKey|passwordHash|tokenHash/);
    const pub = await server.inject({ method: 'GET', url: `/api/v1/public/orders/${o.trackingToken}` });
    expect(pub.body).not.toMatch(/objectKey|passwordHash|tokenHash|shopId/);
  });
});
