import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testPrisma } from './helpers/db.js';
import { advance, baseOptions, buildApp, call, createDocument, login, newOrder, PASSWORD, quoteFor, seedWorld, testConfig, type World } from './api-helpers.js';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('retentionMinutes is server-authoritative and exposed additively', () => {
  it('appears on public shop, tracking, login and session', async () => {
    ({ app } = buildApp({ PRINT_RETENTION_MINUTES: '45' }));
    const shop = await app.inject({ method: 'GET', url: `/api/v1/public/shops/${world.a.slug}` });
    expect(shop.json().data.retentionMinutes).toBe(45);
    const { trackingToken } = await newOrder(app, prisma, world.a);
    const track = await app.inject({ method: 'GET', url: `/api/v1/public/orders/${trackingToken}` });
    expect(track.json().data.retentionMinutes).toBe(45);
    const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: PASSWORD } });
    expect(loginRes.json().data.retentionMinutes).toBe(45);
    expect(loginRes.json().data.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    const s = await login(app, world.a.ownerEmail);
    expect((await call(app, s, 'GET', '/auth/session')).json().data.retentionMinutes).toBe(45);
  });

  it('defaults to 30 and is also present for suspended shops', async () => {
    ({ app } = buildApp());
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/shops/${world.a.slug}` });
    expect(res.json().data).toMatchObject({ status: 'SUSPENDED', retentionMinutes: 30 });
  });
});

describe('rate limits on authenticated surfaces', () => {
  const expectLimited = (res: { statusCode: number; headers: Record<string, unknown>; json: () => any }) => {
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(res.json().error.requestId).toBeTruthy();
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  };

  it('status transitions: per-session bucket, envelope + Retry-After, another session is unaffected', async () => {
    ({ app } = buildApp({ RATE_LIMIT_STATUS_MAX: '3' }));
    const { order } = await newOrder(app, prisma, world.a);
    const s1 = await login(app, world.a.ownerEmail);
    const s2 = await login(app, world.a.ownerEmail); // same IP, different session
    const noop = (s: typeof s1) => call(app!, s, 'POST', `/shop/orders/${order.id}/transitions`, { toStatus: 'NEW', clientRequestId: randomUUID() });
    for (let i = 0; i < 3; i++) expect((await noop(s1)).statusCode).toBe(200);
    expectLimited(await noop(s1));
    expect((await noop(s2)).statusCode).toBe(200);
  });

  it('print-confirmation, document-access, pricing/settings and admin mutations each have their own limit', async () => {
    ({ app } = buildApp({
      RATE_LIMIT_PRINT_CONFIRM_MAX: '2',
      RATE_LIMIT_DOCUMENT_ACCESS_MAX: '2',
      RATE_LIMIT_SHOP_MUTATION_MAX: '2',
      RATE_LIMIT_ADMIN_MUTATION_MAX: '2'
    }));
    const { order } = await newOrder(app, prisma, world.a);
    const shop = await login(app, world.a.ownerEmail);
    // print-confirmation (validation failures still count)
    for (let i = 0; i < 2; i++) expect((await call(app, shop, 'POST', `/shop/orders/${order.id}/print-confirmation`, { clientRequestId: randomUUID() })).statusCode).toBe(409);
    expectLimited(await call(app, shop, 'POST', `/shop/orders/${order.id}/print-confirmation`, { clientRequestId: randomUUID() }));
    // document-access
    for (let i = 0; i < 2; i++) expect((await call(app, shop, 'POST', `/shop/orders/${order.id}/document-access`, {})).statusCode).toBe(200);
    expectLimited(await call(app, shop, 'POST', `/shop/orders/${order.id}/document-access`, {}));
    // settings + pricing share the "shop mutation" bucket
    expect((await call(app, shop, 'PUT', '/shop/settings', { brandColor: '#112233' })).statusCode).toBe(200);
    expect((await call(app, shop, 'POST', '/shop/pricing-rules', { colourMode: 'bw', sides: 'single', pricePerSheetPaise: 5 })).statusCode).toBe(409);
    expectLimited(await call(app, shop, 'PUT', '/shop/settings', { brandColor: '#112233' }));
    // admin mutations
    const admin = await login(app, world.adminEmail);
    for (let i = 0; i < 2; i++) expect((await call(app, admin, 'POST', '/admin/plans', { name: `P${i}`, pricePaise: 1, active: true })).statusCode).toBe(201);
    expectLimited(await call(app, admin, 'POST', '/admin/plans', { name: 'P9', pricePaise: 1, active: true }));
  });

  it('shop reads and the queue use a separate, generous bucket', async () => {
    ({ app } = buildApp({ RATE_LIMIT_SHOP_READ_MAX: '5', RATE_LIMIT_STATUS_MAX: '1' }));
    const shop = await login(app, world.a.ownerEmail);
    for (let i = 0; i < 5; i++) expect((await call(app, shop, 'GET', '/shop/orders')).statusCode).toBe(200);
    expectLimited(await call(app, shop, 'GET', '/shop/orders'));
    // exhausting reads does not block mutations buckets
    const { order } = await newOrder(app, prisma, world.a);
    expect((await call(app, shop, 'POST', `/shop/orders/${order.id}/transitions`, { toStatus: 'NEW', clientRequestId: randomUUID() })).statusCode).toBe(200);
  });

  it('unauthenticated floods against shop/admin scopes hit a per-IP ceiling (no DB lookups forever)', async () => {
    ({ app } = buildApp({ RATE_LIMIT_SHOP_READ_MAX: '2' })); // ceiling = 5x = 10
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await app.inject({ method: 'GET', url: '/api/v1/shop/orders', headers: { cookie: `printout_session=junk${i}` } })).statusCode;
    expect(last).toBe(429);
  });

  it('defaults are generous in production (60-order queue loads are never throttled) and unlimited in test', async () => {
    const { loadConfig } = await import('../src/config.js');
    const prod = loadConfig({
      ...process.env,
      NODE_ENV: 'production',
      SESSION_SECRET: 'p'.repeat(20) + 'Zq8vK2mXw9LrT4bN7cYd',
      CSRF_SECRET: 'c'.repeat(20) + 'Hj3sF6gUe1PaV5oRt0Ik',
      QUOTE_SECRET: 'q'.repeat(20) + 'Bd4nM7xLc2WqE9rYh5Tz',
      STORAGE_URL_SECRET: 's'.repeat(20) + 'Kf8aG1vXj6NpU3yDo2Rb',
      TRUST_PROXY: 'false',
      SSE_HEARTBEAT_MS: '25000',
      ALLOW_LOCAL_STORAGE_IN_PRODUCTION: 'true',
      WEB_ORIGIN: 'https://print.example.org',
      DATABASE_URL: 'postgresql://printout:s3cure-pw@localhost:55433/printout_test_sec'
    });
    expect(prod).toMatchObject({
      RATE_LIMIT_SHOP_READ_MAX: 600,
      RATE_LIMIT_STATUS_MAX: 120,
      RATE_LIMIT_PRINT_CONFIRM_MAX: 60,
      RATE_LIMIT_DOCUMENT_ACCESS_MAX: 60,
      RATE_LIMIT_SHOP_MUTATION_MAX: 60,
      RATE_LIMIT_ADMIN_MUTATION_MAX: 60,
      RATE_LIMIT_SSE_CONNECT_MAX: 30,
      SSE_MAX_CONNECTIONS_PER_SHOP: 10
    });
    expect(testConfig().RATE_LIMIT_SHOP_READ_MAX).toBeGreaterThanOrEqual(100_000);
  });

  it('public routes keep their per-IP limit with Retry-After and the RATE_LIMITED envelope', async () => {
    ({ app } = buildApp({ PUBLIC_RATE_LIMIT_MAX: '2' }));
    const get = () => app!.inject({ method: 'GET', url: `/api/v1/public/shops/${world.a.slug}` });
    await get();
    await get();
    expectLimited(await get());
  });
});

describe('proxy trust: forwarded client IPs are honoured only from trusted hops', () => {
  const ipOf = async (overrides: Record<string, string>, remoteAddress: string, xff?: string) => {
    const built = buildApp(overrides);
    app = built.app;
    app.get('/_ip', async (request) => ({ ip: request.ip }));
    const res = await app.inject({ method: 'GET', url: '/_ip', remoteAddress, headers: xff ? { 'x-forwarded-for': xff } : {} });
    return res.json().ip as string;
  };

  it('no proxy trust by default (local dev): X-Forwarded-For is ignored', async () => {
    expect(await ipOf({}, '203.0.113.9', '1.2.3.4')).toBe('203.0.113.9');
  });

  it('TRUST_PROXY_CIDRS=loopback,linklocal,uniquelocal honours a docker-network hop', async () => {
    expect(await ipOf({ TRUST_PROXY_CIDRS: 'loopback,linklocal,uniquelocal' }, '172.18.0.5', '198.51.100.7')).toBe('198.51.100.7');
  });

  it('an untrusted direct client cannot change its address with X-Forwarded-For', async () => {
    expect(await ipOf({ TRUST_PROXY_CIDRS: 'loopback,linklocal,uniquelocal' }, '203.0.113.9', '198.51.100.7')).toBe('203.0.113.9');
  });

  it('a forged left-hand XFF entry behind a trusted proxy is ignored (rightmost untrusted wins)', async () => {
    expect(await ipOf({ TRUST_PROXY_CIDRS: '10.0.0.0/8' }, '10.0.0.5', '6.6.6.6, 198.51.100.7')).toBe('198.51.100.7');
  });

  it('login throttle key cannot be rotated by an untrusted client sending forged XFF', async () => {
    ({ app } = buildApp({ LOGIN_FAIL_MAX: '3' }));
    const attempt = (i: number, password: string) =>
      app!.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '203.0.113.9',
        headers: { 'x-forwarded-for': `10.9.${i}.1` },
        payload: { email: world.a.ownerEmail, password }
      });
    for (let i = 0; i < 3; i++) expect((await attempt(i, 'wrong-password-123')).statusCode).toBe(401);
    expect((await attempt(50, PASSWORD)).statusCode).toBe(429); // same real IP => same bucket
  });

  it('route rate-limit buckets: spoofed XFF shares one bucket when untrusted, separate buckets behind a trusted proxy', async () => {
    ({ app } = buildApp({ PUBLIC_RATE_LIMIT_MAX: '2' }));
    const hit = (xff: string, remote: string) => app!.inject({ method: 'GET', url: `/api/v1/public/shops/${world.a.slug}`, remoteAddress: remote, headers: { 'x-forwarded-for': xff } });
    await hit('1.1.1.1', '203.0.113.9');
    await hit('2.2.2.2', '203.0.113.9');
    expect((await hit('3.3.3.3', '203.0.113.9')).statusCode).toBe(429);
    await app.close();
    ({ app } = buildApp({ PUBLIC_RATE_LIMIT_MAX: '2', TRUST_PROXY_CIDRS: '172.16.0.0/12' }));
    await hit('1.1.1.1', '172.18.0.2');
    await hit('1.1.1.1', '172.18.0.2');
    expect((await hit('1.1.1.1', '172.18.0.2')).statusCode).toBe(429);
    expect((await hit('9.9.9.9', '172.18.0.2')).statusCode).toBe(200); // a different real client behind the proxy
  });
});

describe('shop / subscription eligibility', () => {
  const upload = (slug: string) =>
    app!.inject({ method: 'POST', url: `/api/v1/public/shops/${slug}/uploads/initiate`, payload: { fileName: 'a.pdf', byteSize: 1000, declaredMimeType: 'application/pdf' } });

  it('SUSPENDED shop: no new uploads/quotes/orders; existing data untouched; staff blocked; worker still deletes', async () => {
    ({ app } = buildApp());
    const { doc, order } = await newOrder(app, prisma, world.a);
    const fresh = await createDocument(prisma, world.a.shopId);
    const owner = await login(app, world.a.ownerEmail);
    const admin = await login(app, world.adminEmail);
    const res = await call(app, admin, 'PUT', `/admin/shops/${world.a.shopId}`, { status: 'SUSPENDED' });
    expect(res.statusCode).toBe(200);

    expect((await upload(world.a.slug)).statusCode).toBe(404);
    expect((await quoteFor(app, world.a.slug, fresh.id)).statusCode).toBe(404);
    const orderRes = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/orders`, payload: { quoteId: 'x'.repeat(20), clientRequestId: randomUUID() } });
    expect(orderRes.statusCode).toBe(404);
    // staff cannot act (existing session was invalidated) nor sign in again
    expect((await call(app, owner, 'GET', '/shop/orders')).statusCode).toBe(401);
    const relog = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: PASSWORD } });
    expect(relog.statusCode).toBe(403);
    expect(relog.json().error.code).toBe('SHOP_SUSPENDED');
    // existing order/document metadata untouched
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('AVAILABLE');
    const audits = await prisma.auditLog.findMany({ where: { action: 'admin.shop.suspend' } });
    expect(audits).toHaveLength(1);
    // reactivation is audit-logged as well
    await call(app, admin, 'PUT', `/admin/shops/${world.a.shopId}`, { status: 'ACTIVE' });
    expect(await prisma.auditLog.count({ where: { action: 'admin.shop.activate' } })).toBe(1);
    expect((await upload(world.a.slug)).statusCode).toBe(200);
  });

  it.each(['SUSPENDED', 'CANCELLED'] as const)('subscription %s: intake blocked, owner keeps login/reads/handling, audit-logged', async (status) => {
    ({ app } = buildApp());
    const { order, trackingToken } = await newOrder(app, prisma, world.a);
    const fresh = await createDocument(prisma, world.a.shopId);
    const quote = await quoteFor(app, world.a.slug, fresh.id);
    expect(quote.statusCode).toBe(200);
    const admin = await login(app, world.adminEmail);
    const sub = await call(app, admin, 'PUT', `/admin/subscriptions/${world.a.shopId}`, { status });
    expect(sub.statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'admin.subscription.update', shopId: world.a.shopId } })).toBe(1);

    // new public intake refused with the designed codes
    expect((await upload(world.a.slug)).statusCode).toBe(404);
    expect((await upload(world.a.slug)).json().error.code).toBe('SHOP_UNAVAILABLE');
    const q2 = await quoteFor(app, world.a.slug, fresh.id);
    expect(q2.statusCode).toBe(409);
    expect(q2.json().error.code).toBe('SHOP_UNAVAILABLE');
    const o2 = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/orders`, payload: { quoteId: quote.json().data.quoteId, clientRequestId: randomUUID() } });
    expect(o2.statusCode).toBe(409);
    expect(o2.json().error.code).toBe('SHOP_UNAVAILABLE');
    // the public shop page shows it as not accepting orders; tracking of existing orders still works
    const page = await app.inject({ method: 'GET', url: `/api/v1/public/shops/${world.a.slug}` });
    expect(page.json().data.acceptsOrders).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/v1/public/orders/${trackingToken}` })).statusCode).toBe(200);
    // the owner can still sign in, read and process existing orders
    const owner = await login(app, world.a.ownerEmail);
    expect((await call(app, owner, 'GET', '/shop/orders')).statusCode).toBe(200);
    await advance(app, owner, order.id, 'ACCEPTED');
    // re-activating the subscription re-opens intake
    await call(app, admin, 'PUT', `/admin/subscriptions/${world.a.shopId}`, { status: 'ACTIVE' });
    expect((await upload(world.a.slug)).statusCode).toBe(200);
    // shops without any subscription row are not blocked
    await prisma.subscription.delete({ where: { shopId: world.a.shopId } });
    expect((await upload(world.a.slug)).statusCode).toBe(200);
  });

  it('the retention worker still deletes documents of suspended / subscription-suspended shops on schedule', async () => {
    ({ app } = buildApp());
    const { doc } = await newOrder(app, prisma, world.a);
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    await prisma.subscription.update({ where: { shopId: world.a.shopId }, data: { status: 'SUSPENDED' } });
    await prisma.document.update({ where: { id: doc.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const { cleanupExpiredDocuments } = await import('../src/cleanup.js');
    const deleted: string[] = [];
    const storage = { delete: async (k: string) => void deleted.push(k), exists: async (k: string) => !deleted.includes(k) };
    const result = await cleanupExpiredDocuments(prisma, storage, { now: new Date(), batchSize: 10, staleUploadMinutes: 60, log: {} });
    expect(result.deleted).toBe(1);
    expect(deleted).toContain(doc.objectKey);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('DELETED');
  });
});

describe('health and readiness', () => {
  const stubPrisma = (impl: () => Promise<unknown>) => ({ $queryRaw: impl, $disconnect: async () => undefined }) as never;

  it('/health never touches the database; /ready is 200 with a working DB', async () => {
    const built = createApp({ config: testConfig(), prisma: stubPrisma(() => Promise.reject(new Error('db down'))) });
    app = built.app;
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().data.status).toBe('ok');
    await app.close();
    ({ app } = buildApp());
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data.status).toBe('ready');
  });

  it('/ready answers 503 with the error envelope when the DB errors', async () => {
    const built = createApp({ config: testConfig(), prisma: stubPrisma(() => Promise.reject(new Error('connect ECONNREFUSED postgres:5432 password=hunter2'))) });
    app = built.app;
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Database unavailable' });
    expect(res.json().error.requestId).toBeTruthy();
    expect(res.body).not.toMatch(/ECONNREFUSED|hunter2|postgres/);
  });

  it('/ready answers 503 quickly when the DB hangs', async () => {
    const built = createApp({ config: testConfig(), prisma: stubPrisma(() => new Promise(() => undefined)), readyTimeoutMs: 80 });
    app = built.app;
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('Cache-Control: no-store everywhere sensitive', () => {
  it('tracking, auth, shop, admin, document-access, errors and health responses are not cacheable', async () => {
    ({ app } = buildApp());
    const { order, trackingToken } = await newOrder(app, prisma, world.a);
    const shop = await login(app, world.a.ownerEmail);
    const admin = await login(app, world.adminEmail);
    const responses = [
      await app.inject({ method: 'GET', url: `/api/v1/public/orders/${trackingToken}` }),
      await app.inject({ method: 'GET', url: '/api/v1/public/orders/not-a-real-token' }),
      await app.inject({ method: 'GET', url: `/api/v1/public/shops/${world.a.slug}` }),
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: PASSWORD } }),
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: 'nope-nope-nope' } }),
      await call(app, shop, 'GET', '/auth/session'),
      await call(app, shop, 'GET', '/shop/orders'),
      await call(app, shop, 'GET', `/shop/orders/${order.id}`),
      await call(app, shop, 'POST', `/shop/orders/${order.id}/document-access`, {}),
      await call(app, shop, 'GET', '/shop/settings'),
      await call(app, admin, 'GET', '/admin/shops'),
      await call(app, null, 'GET', '/shop/orders'),
      await app.inject({ method: 'GET', url: '/health' }),
      await app.inject({ method: 'GET', url: '/nope' })
    ];
    for (const res of responses) expect(String(res.headers['cache-control']), res.body.slice(0, 80)).toMatch(/no-store/);
  });
});

describe('logs and error bodies never contain secrets (production config)', () => {
  const prodConfig = () =>
    testConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'p'.repeat(20) + 'Zq8vK2mXw9LrT4bN7cYd',
      CSRF_SECRET: 'c'.repeat(20) + 'Hj3sF6gUe1PaV5oRt0Ik',
      QUOTE_SECRET: 'q'.repeat(20) + 'Bd4nM7xLc2WqE9rYh5Tz',
      STORAGE_URL_SECRET: 's'.repeat(20) + 'Kf8aG1vXj6NpU3yDo2Rb',
      TRUST_PROXY: 'false',
      SSE_HEARTBEAT_MS: '25000',
      ALLOW_LOCAL_STORAGE_IN_PRODUCTION: 'true',
      WEB_ORIGIN: 'https://print.example.org',
      DATABASE_URL: 'postgresql://printout:s3cure-pw@localhost:55433/printout_test_sec'
    });

  it('exercises every route class and finds no document bytes, tokens, signatures, cookies, CSRF or passwords', async () => {
    let logs = '';
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        logs += chunk.toString();
        cb();
      }
    });
    const config = prodConfig();
    const built = createApp({ config, prisma, logStream });
    app = built.app;
    app.get('/_boom', async () => {
      throw Object.assign(new Error('Invalid `prisma.user.findUnique()` invocation: where: { email: "victim@x.test", tokenHash: "TOPSECRETHASH" }'), { name: 'PrismaClientKnownRequestError', code: 'P2002' });
    });

    const WRONG = 'wrong-secret-pw-987654';
    const bodies: string[] = [];
    const keep = <T extends { body: string }>(res: T): T => {
      bodies.push(res.body);
      return res;
    };
    const secrets: string[] = [WRONG, PASSWORD];

    // auth: failed + successful login, validation errors echoing input
    keep(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: WRONG } }));
    keep(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: WRONG, role: 'PLATFORM_ADMIN' } }));
    keep(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'not-an-email', password: WRONG + 'x'.repeat(300) } }));
    const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: PASSWORD } });
    const cookieValue = (loginRes.cookies.find((c) => c.name === 'printout_session')!).value;
    const csrf = loginRes.json().data.csrfToken as string;
    const shop = { cookie: `printout_session=${cookieValue}`, csrf, userId: loginRes.json().data.user.id };
    secrets.push(cookieValue, csrf);

    // customer flow incl. real upload + signed document URL
    const { makePdf } = await import('./fixtures/make.js');
    const pdf = await makePdf(2);
    const init = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/uploads/initiate`, payload: { fileName: 'secret-name.pdf', byteSize: pdf.length, declaredMimeType: 'application/pdf' } });
    const { uploadId, uploadUrl } = init.json().data;
    const uploadToken = new URL(uploadUrl, 'http://x').searchParams.get('token')!;
    secrets.push(uploadToken);
    keep(await app.inject({ method: 'PUT', url: uploadUrl, payload: pdf, headers: { 'content-type': 'application/pdf' } }));
    keep(await app.inject({ method: 'PUT', url: uploadUrl, payload: pdf, headers: { 'content-type': 'application/pdf' } })); // reuse -> error path
    keep(await app.inject({ method: 'PUT', url: uploadUrl.replace(uploadToken, 'forged.token'), payload: pdf, headers: { 'content-type': 'application/pdf' } }));
    keep(await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/uploads/${uploadId}/complete` }));
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: uploadId } });
    secrets.push(doc.objectKey);
    const q = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/quotes`, payload: { documentId: uploadId, printOptions: baseOptions } });
    const quoteId = q.json().data.quoteId as string;
    secrets.push(quoteId);
    keep(await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/quotes`, payload: { documentId: uploadId, printOptions: { ...baseOptions, colourMode: 'SECRET-ENUM-VALUE' } } }));
    const o = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/orders`, payload: { quoteId, clientRequestId: randomUUID() } });
    const tracking = o.json().data.trackingToken as string;
    secrets.push(tracking);
    keep(await app.inject({ method: 'GET', url: `/api/v1/public/orders/${tracking}` }));
    keep(await app.inject({ method: 'GET', url: '/api/v1/public/orders/BADTRACKINGTOKEN123' }));

    // shop flow: queue, detail, transitions, print confirmation, document access, signed fetch
    const order = await prisma.order.findFirstOrThrow({ where: { trackingToken: tracking } });
    keep(await call(app, shop, 'GET', '/shop/orders'));
    keep(await call(app, shop, 'GET', `/shop/orders/${order.id}`));
    await advance(app, shop, order.id, 'ACCEPTED', 'PRINTING');
    keep(await call(app, shop, 'POST', `/shop/orders/${order.id}/print-confirmation`, { clientRequestId: randomUUID() }));
    const access = await call(app, shop, 'POST', `/shop/orders/${order.id}/document-access`, {});
    const accessUrl = access.json().data.url as string;
    const parsed = new URL(accessUrl, 'http://x');
    secrets.push(parsed.searchParams.get('sig')!, accessUrl);
    const fetched = await app.inject({ method: 'GET', url: accessUrl });
    expect(fetched.statusCode).toBe(200);
    await app.inject({ method: 'GET', url: accessUrl.replace(/sig=[0-9a-f]+/, 'sig=' + '0'.repeat(64)) });
    keep(await call(app, shop, 'PUT', '/shop/settings', { acceptsOrders: 'MAYBE-SECRET' }));
    keep(await call(app, shop, 'POST', '/shop/orders/does-not-exist/transitions', { toStatus: 'WHATEVER-SECRET', clientRequestId: 'nope' }));
    keep(await call(app, { ...shop, csrf: 'bad-csrf-token-value' }, 'POST', `/shop/orders/${order.id}/document-access`, {}));

    // admin flow including a too-short initial password in a validation error
    const adminLogin = await login(app, world.adminEmail);
    secrets.push(adminLogin.cookie.split('=')[1]!, adminLogin.csrf);
    keep(await call(app, adminLogin, 'GET', '/admin/shops'));
    const shortPw = 'short-pw-1';
    secrets.push(shortPw);
    keep(await call(app, adminLogin, 'POST', '/admin/shops', { slug: 'new-shop', displayName: 'N', owner: { email: 'n@x.test', displayName: 'N', password: shortPw } }));
    const strongPw = 'very-strong-initial-pw-42';
    secrets.push(strongPw);
    keep(await call(app, adminLogin, 'POST', '/admin/shops', { slug: 'new-shop', displayName: 'N', owner: { email: 'n@x.test', displayName: 'N', password: strongPw } }));
    keep(await call(app, adminLogin, 'POST', '/admin/shops', { slug: 'new-shop', displayName: 'N', owner: { email: 'n@x.test', displayName: 'N', password: strongPw } })); // conflict path

    // a 500 with an ORM-style message embedding query arguments
    const boom = keep(await app.inject({ method: 'GET', url: '/_boom' }));
    expect(boom.statusCode).toBe(500);
    await app.inject({ method: 'GET', url: '/ready' });
    await call(app, shop, 'POST', '/auth/logout', {});

    // production-relevant secrets from config as well
    secrets.push(config.SESSION_SECRET, config.CSRF_SECRET, config.QUOTE_SECRET!, config.STORAGE_URL_SECRET!, 'TOPSECRETHASH', 'victim@x.test');
    const pdfBytes = pdf.subarray(0, 40).toString('latin1');

    expect(logs.length).toBeGreaterThan(500); // logging was actually captured
    for (const secret of secrets.filter(Boolean)) {
      expect(logs, `log leaked ${secret.slice(0, 12)}`).not.toContain(secret);
    }
    expect(logs).not.toContain(pdfBytes);
    expect(logs).not.toMatch(/sig=|[?&]token=|[?&]exp=/);
    expect(logs).not.toMatch(/set-cookie|printout_session=/i);
    // error bodies: never echo passwords / submitted enum values / tokens / ORM text
    const errorBodies = bodies.join('\n');
    for (const secret of [WRONG, shortPw, strongPw, 'SECRET-ENUM-VALUE', 'MAYBE-SECRET', 'WHATEVER-SECRET', 'TOPSECRETHASH', 'victim@x.test', doc.objectKey, uploadToken, 'bad-csrf-token-value']) {
      expect(errorBodies, `response echoed ${secret.slice(0, 12)}`).not.toContain(secret);
    }
    // sanity: validation details are still useful (field names), just without the echoed input
    const validation = JSON.parse(bodies[2]!);
    expect(validation.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(validation.error.details.fieldErrors)).toContain('email');
    await sleep(0);
  });
});
