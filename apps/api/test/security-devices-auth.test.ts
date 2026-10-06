import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { hashDeviceCredential } from '../src/device-auth.js';
import { testPrisma } from './helpers/db.js';
import { buildApp, call, login, newOrder, seedDevice, seedWorld, testConfig, type Session, type World } from './api-helpers.js';

const prisma = testPrisma();
let world: World;
beforeEach(async () => {
  world = await seedWorld(prisma);
});

/** Collects every route registered under the device / owner-device surface so a NEW route cannot ship unreviewed. */
async function withRoutes() {
  const built = buildApp();
  const routes: Array<{ method: string; url: string }> = [];
  built.app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD' && m !== 'OPTIONS') routes.push({ method: m as string, url: r.url });
  });
  await built.app.ready();
  return { ...built, routes };
}

const EXPECTED_DEVICE_ROUTES = [
  'GET /api/v1/device/me',
  'GET /api/v1/device/orders',
  'GET /api/v1/device/orders/:id',
  'POST /api/v1/device/heartbeat',
  'POST /api/v1/device/orders/:id/download',
  'POST /api/v1/device/orders/:id/print',
  'POST /api/v1/device/orders/:id/reprint',
  'PUT /api/v1/device/push-token'
];
const EXPECTED_OWNER_DEVICE_ROUTES = [
  'GET /api/v1/shop/devices',
  'PATCH /api/v1/shop/devices/:id',
  'POST /api/v1/shop/devices/:id/revoke',
  'POST /api/v1/shop/devices/pairing-codes'
];

describe('route inventory: every device / owner-device route has the right guard', () => {
  it('the device + owner-device route set is exactly the reviewed one (adding a route fails this test)', async () => {
    const { app, routes } = await withRoutes();
    const sig = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
    const device = routes.filter((r) => r.url.startsWith('/api/v1/device/') && r.url !== '/api/v1/device/pair').map(sig).sort();
    const owner = routes.filter((r) => r.url.startsWith('/api/v1/shop/devices')).map(sig).sort();
    expect(device).toEqual([...EXPECTED_DEVICE_ROUTES].sort());
    expect(owner).toEqual([...EXPECTED_OWNER_DEVICE_ROUTES].sort());
    expect(routes.filter((r) => r.url === '/api/v1/device/pair').map(sig)).toEqual(['POST /api/v1/device/pair']);
    await app.close();
  });

  it('EVERY /device/* route (except pair): anonymous, owner-cookie+CSRF, admin-cookie, garbage, revoked => 401; valid device passes the guard; cookies+CSRF are never required', async () => {
    const { app, routes } = await withRoutes();
    const owner = await login(app, world.a.ownerEmail);
    const admin = await login(app, world.adminEmail);
    const live = await seedDevice(prisma, world.a.shopId);
    const revoked = await seedDevice(prisma, world.a.shopId, { status: 'REVOKED' });
    const o = await newOrder(app, prisma, world.a);
    const targets = routes.filter((r) => r.url.startsWith('/api/v1/device/') && r.url !== '/api/v1/device/pair');
    expect(targets.length).toBe(EXPECTED_DEVICE_ROUTES.length);
    for (const r of targets) {
      const url = r.url.replace(':id', o.order.id);
      const send = (headers: Record<string, string>) =>
        app.inject({ method: r.method as 'GET', url, headers, payload: r.method === 'GET' ? undefined : {} });
      const label = `${r.method} ${r.url}`;
      expect((await send({})).statusCode, `${label} anonymous`).toBe(401);
      expect((await send({ cookie: owner.cookie, 'x-csrf-token': owner.csrf })).statusCode, `${label} owner session`).toBe(401);
      expect((await send({ cookie: admin.cookie, 'x-csrf-token': admin.csrf })).statusCode, `${label} admin session`).toBe(401);
      expect((await send({ authorization: 'Bearer pbd_' + 'A'.repeat(43) })).statusCode, `${label} garbage`).toBe(401);
      const rev = await send(revoked.auth);
      expect(rev.statusCode, `${label} revoked`).toBe(401);
      expect(rev.json().error.code).toBe('DEVICE_REVOKED');
      // a live device passes the guard with NO cookie and NO csrf header (the route itself may still say 400/404/409)
      const ok = await send(live.auth);
      expect([401, 403], `${label} live device`).not.toContain(ok.statusCode);
    }
    await app.close();
  }, 60_000);

  it('EVERY /shop/devices* route: anonymous 401, device bearer 401, admin 403, missing CSRF 403; device credentials are not owner sessions', async () => {
    const { app, routes } = await withRoutes();
    const owner = await login(app, world.a.ownerEmail);
    const admin = await login(app, world.adminEmail);
    const live = await seedDevice(prisma, world.a.shopId);
    const targets = routes.filter((r) => r.url.startsWith('/api/v1/shop/devices'));
    expect(targets.length).toBe(EXPECTED_OWNER_DEVICE_ROUTES.length);
    for (const r of targets) {
      const url = r.url.replace(':id', live.device.id);
      const label = `${r.method} ${r.url}`;
      const body = r.method === 'PATCH' ? { name: 'x' } : {};
      const send = (headers: Record<string, string>) =>
        app.inject({ method: r.method as 'GET', url, headers, payload: r.method === 'GET' ? undefined : body });
      expect((await send({})).statusCode, `${label} anonymous`).toBe(401);
      expect((await send(live.auth)).statusCode, `${label} device bearer`).toBe(401);
      expect((await send({ cookie: admin.cookie, 'x-csrf-token': admin.csrf })).statusCode, `${label} admin`).toBe(403);
      if (r.method !== 'GET') expect((await send({ cookie: owner.cookie })).statusCode, `${label} no csrf`).toBe(403);
    }
    await app.close();
  }, 60_000);
});

describe('device Authorization header edge cases', () => {
  async function setup() {
    const built = buildApp();
    await built.app.ready();
    const d = await seedDevice(prisma, world.a.shopId);
    const me = (headers: Record<string, string>, url = '/api/v1/device/me') => built.app.inject({ method: 'GET', url, headers });
    return { ...built, d, me };
  }
  afterEach(() => undefined);

  it('rejects wrong scheme, wrong case of the credential prefix, extra tokens, empty / prefix-only credentials and oversize values', async () => {
    const { app, d, me } = await setup();
    const s = d.secret;
    const bad = [
      `Basic ${s}`,
      `Token ${s}`,
      `Bearer`,
      `Bearer `,
      `Bearer pbd_`,
      `Bearer ${s} extra`,
      `Bearer ${s}x`,
      `Bearer ${s.slice(0, -1)}`,
      `Bearer ${s.toUpperCase()}`,
      `Bearer ${s.replace(/^pbd_/, 'PBD_')}`,
      `Bearer ${s.replace(/^pbd_/, '')}`,
      `bearer ${s}`,
      `BEARER ${s}`,
      `Bearer ${'pbd_' + 'A'.repeat(5000)}`,
      `Bearer ${hashDeviceCredential(s)}`
    ];
    for (const h of bad) {
      const r = await me({ authorization: h });
      expect(r.statusCode, h.slice(0, 40)).toBe(401);
      expect(r.json().error.code).toBe('UNAUTHORIZED');
    }
    // sanity: the exact credential works, and surrounding whitespace around the token is tolerated (trimmed) but nothing else
    expect((await me({ authorization: `Bearer ${s}` })).statusCode).toBe(200);
    expect((await me({ authorization: `Bearer  ${s} ` })).statusCode).toBe(200);
    await app.close();
  });

  it('the credential is only accepted in Authorization: not in the query string, a cookie or another header', async () => {
    const { app, d, me } = await setup();
    expect((await me({}, `/api/v1/device/me?access_token=${d.secret}`)).statusCode).toBe(401);
    expect((await me({}, `/api/v1/device/me?authorization=Bearer%20${d.secret}`)).statusCode).toBe(401);
    expect((await me({ cookie: `printout_session=${d.secret}` })).statusCode).toBe(401);
    expect((await me({ cookie: `authorization=Bearer ${d.secret}` })).statusCode).toBe(401);
    expect((await me({ 'x-device-credential': d.secret })).statusCode).toBe(401);
    expect((await me({ 'x-api-key': d.secret })).statusCode).toBe(401);
    await app.close();
  });

  it('a device Bearer credential is not accepted on owner or admin routes; mutations need no CSRF token', async () => {
    const { app, d } = await setup();
    for (const url of ['/api/v1/shop/orders', '/api/v1/shop/devices', '/api/v1/admin/shops']) {
      expect((await app.inject({ method: 'GET', url, headers: d.auth })).statusCode, url).toBe(401);
    }
    const hb = await app.inject({ method: 'POST', url: '/api/v1/device/heartbeat', headers: d.auth, payload: {} });
    expect(hb.statusCode).toBe(200);
    await app.close();
  });

  it('two Authorization headers on the wire cannot smuggle a credential past the guard', async () => {
    const { app, d } = await setup();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const raw = (headers: Array<[string, string]>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/device/me', method: 'GET', headers: {} }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        // write raw header lines to preserve duplicates
        for (const [k, v] of headers) req.setHeader(k, v);
        req.end();
      });
    // Node keeps one value; whichever it keeps, a bogus first value must never authenticate, and no 5xx ever occurs.
    const sock = (first: string, second: string) =>
      new Promise<number>((resolve, reject) => {
        import('node:net').then(({ createConnection }) => {
          const c = createConnection({ host: '127.0.0.1', port }, () => {
            c.write(
              `GET /api/v1/device/me HTTP/1.1\r\nHost: x\r\nAuthorization: ${first}\r\nAuthorization: ${second}\r\nConnection: close\r\n\r\n`
            );
          });
          let buf = '';
          c.on('data', (b) => (buf += b.toString()));
          c.on('close', () => resolve(Number(/HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0)));
          c.on('error', reject);
        });
      });
    void raw;
    expect(await sock('Bearer pbd_bogus', d.auth.authorization)).toBe(401);
    const both = await sock(d.auth.authorization, 'Bearer pbd_bogus');
    expect([200, 400, 401]).toContain(both);
    await app.close();
  });
});

describe('credential never logged (NODE_ENV=development logger capture)', () => {
  it('neither the raw credential, its sha256, nor the Authorization header appear in request, rejection or 5xx logs', async () => {
    let logged = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logged += chunk.toString();
        cb();
      }
    });
    const built = createApp({ config: testConfig({ NODE_ENV: 'development' }), prisma, logStream: stream });
    const app = built.app;
    await app.ready();
    const live = await seedDevice(prisma, world.a.shopId);
    const revoked = await seedDevice(prisma, world.a.shopId, { status: 'REVOKED' });
    const o = await newOrder(app, prisma, world.a);
    await app.inject({ method: 'GET', url: '/api/v1/device/me', headers: live.auth });
    await app.inject({ method: 'GET', url: '/api/v1/device/orders', headers: live.auth });
    await app.inject({ method: 'GET', url: '/api/v1/device/me', headers: revoked.auth });
    await app.inject({ method: 'GET', url: '/api/v1/device/me', headers: { authorization: 'Bearer pbd_' + 'Z'.repeat(43) } });
    await app.inject({ method: 'POST', url: `/api/v1/device/orders/${o.order.id}/print`, headers: live.auth, payload: { clientRequestId: 'not-a-uuid' } });
    // force a 5xx on the device print path: the error logger must still not contain the header
    const spy = vi.spyOn(built.storage, 'temporaryReadUrl').mockRejectedValueOnce(new Error('storage exploded'));
    const five = await app.inject({
      method: 'POST',
      url: `/api/v1/device/orders/${o.order.id}/print`,
      headers: live.auth,
      payload: { clientRequestId: randomUUID() }
    });
    spy.mockRestore();
    expect(five.statusCode).toBeGreaterThanOrEqual(500);
    expect(logged).toContain('request failed');
    expect(logged).toContain('incoming request');
    for (const needle of [live.secret, live.secret.slice(4), revoked.secret, hashDeviceCredential(live.secret), hashDeviceCredential(revoked.secret), 'Bearer pbd_']) {
      expect(logged, needle.slice(0, 12)).not.toContain(needle);
    }
    expect(logged.toLowerCase()).not.toMatch(/"authorization"\s*:\s*"bearer/);
    await app.close();
  });
});

describe('device print: replay and double-submit of the same clientRequestId', () => {
  it('replaying one clientRequestId sequentially and in parallel yields exactly one firstPrint, one initiated audit and identical timestamps', async () => {
    const { app } = await withRoutes();
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const id = randomUUID();
    const send = () => app.inject({ method: 'POST', url: `/api/v1/device/orders/${o.order.id}/print`, headers: d.auth, payload: { clientRequestId: id } });
    const first = await send();
    const replay = await send();
    const parallel = await Promise.all([send(), send(), send()]);
    const all = [first, replay, ...parallel];
    expect(all.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(all.filter((r) => r.json().data.firstPrint)).toHaveLength(1);
    expect(first.json().data.firstPrint).toBe(true);
    expect(new Set(all.map((r) => r.json().data.document.deleteAfter)).size).toBe(1);
    expect(await prisma.auditLog.count({ where: { targetId: o.order.id, action: 'order.printInitiated' } })).toBe(1);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: o.order.id, fromStatus: { not: null } } })).toBe(2);
    await app.close();
  });
});

describe('legacy rows with printedAt but no printInitiatedAt', () => {
  it('stay readable and reprintable (browser and device) until deleteAfter and a device Print never re-runs firstPrint', async () => {
    const { app } = await withRoutes();
    const owner = await login(app, world.a.ownerEmail);
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const printedAt = new Date(Date.now() - 5 * 60_000);
    const deleteAfter = new Date(Date.now() + 10 * 60_000);
    await prisma.document.update({
      where: { id: o.doc.id },
      data: { status: 'PRINTED_RETENTION', printedAt, deleteAfter, printInitiatedAt: null }
    });
    await prisma.order.update({ where: { id: o.order.id }, data: { status: 'PRINTED' } });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/device/orders/${o.order.id}`, headers: d.auth });
    expect(detail.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/device/orders/${o.order.id}/reprint`, headers: d.auth, payload: {} })).statusCode).toBe(200);
    expect((await call(app, owner, 'POST', `/shop/orders/${o.order.id}/document-access`, {})).statusCode).toBe(200);
    const again = await app.inject({
      method: 'POST', url: `/api/v1/device/orders/${o.order.id}/print`, headers: d.auth, payload: { clientRequestId: randomUUID() }
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.firstPrint).toBe(false);
    const after = await prisma.document.findUniqueOrThrow({ where: { id: o.doc.id } });
    expect(after.printInitiatedAt).toBeNull();
    expect(after.deleteAfter!.getTime()).toBe(deleteAfter.getTime());
    expect(after.printedAt!.getTime()).toBe(printedAt.getTime());
    expect(await prisma.auditLog.count({ where: { targetId: o.order.id, action: 'order.printInitiated' } })).toBe(0);
    // past deleteAfter everything is denied
    await prisma.document.update({ where: { id: o.doc.id }, data: { deleteAfter: new Date(Date.now() - 1000) } });
    expect((await app.inject({ method: 'POST', url: `/api/v1/device/orders/${o.order.id}/reprint`, headers: d.auth, payload: {} })).statusCode).toBe(410);
    expect((await call(app, owner, 'POST', `/shop/orders/${o.order.id}/document-access`, {})).statusCode).toBe(410);
    await app.close();
  });
});

describe('document URL lifetime never outlives deleteAfter on device paths', () => {
  it('reprint / download / late print: expiresAt <= deleteAfter and the signed lifetime is capped to the remaining window', async () => {
    const { app, storage } = await withRoutes();
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const first = await app.inject({ method: 'POST', url: `/api/v1/device/orders/${o.order.id}/print`, headers: d.auth, payload: { clientRequestId: randomUUID() } });
    expect(first.statusCode).toBe(200);
    const deleteAfter = new Date(Date.now() + 90_000);
    await prisma.document.update({ where: { id: o.doc.id }, data: { deleteAfter } });
    const spy = vi.spyOn(storage, 'temporaryReadUrl');
    for (const path of ['reprint', 'download']) {
      const r = await app.inject({ method: 'POST', url: `/api/v1/device/orders/${o.order.id}/${path}`, headers: d.auth, payload: {} });
      expect(r.statusCode).toBe(200);
      expect(new Date(r.json().data.expiresAt).getTime()).toBeLessThanOrEqual(deleteAfter.getTime());
    }
    const late = await app.inject({ method: 'POST', url: `/api/v1/device/orders/${o.order.id}/print`, headers: d.auth, payload: { clientRequestId: randomUUID() } });
    expect(late.statusCode).toBe(200);
    expect(late.json().data.firstPrint).toBe(false);
    expect(new Date(late.json().data.access.expiresAt).getTime()).toBeLessThanOrEqual(deleteAfter.getTime());
    for (const call of spy.mock.calls) expect(call[1]).toBeLessThanOrEqual(90);
    spy.mockRestore();
    await app.close();
  });
});

describe('audit / history / SSE payload hygiene for device actions', () => {
  it('no URL, object key, filename or credential in audit rows, history rows or SSE frames; SSE frames only carry ids/status/timestamps', async () => {
    const { app, events } = await withRoutes();
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const frames: string[] = [];
    const off = events.subscribe(world.a.shopId, { write: (c: string) => frames.push(c), close: () => undefined } as never);
    const url = (p: string) => `/api/v1/device/orders/${o.order.id}/${p}`;
    const pr = await app.inject({ method: 'POST', url: url('print'), headers: d.auth, payload: { clientRequestId: randomUUID() } });
    const re = await app.inject({ method: 'POST', url: url('reprint'), headers: d.auth, payload: {} });
    const dl = await app.inject({ method: 'POST', url: url('download'), headers: d.auth, payload: {} });
    off();
    expect([pr.statusCode, re.statusCode, dl.statusCode]).toEqual([200, 200, 200]);
    const docRow = await prisma.document.findUniqueOrThrow({ where: { id: o.doc.id } });
    const dump = JSON.stringify([
      await prisma.auditLog.findMany(),
      await prisma.orderStatusHistory.findMany(),
      frames
    ]);
    const issued = [pr.json().data.access.url, re.json().data.url, dl.json().data.url] as string[];
    for (const needle of [docRow.objectKey, docRow.originalFilename, d.secret, hashDeviceCredential(d.secret), 'http://', 'https://', 'X-Amz', ...issued]) {
      expect(dump, needle.slice(0, 20)).not.toContain(needle);
    }
    expect(frames.length).toBeGreaterThan(0);
    const allowed = new Set(['orderId', 'documentId', 'deleteAfter', 'id', 'orderNumber', 'status', 'updatedAt', 'shopId', 'fromStatus', 'toStatus', 'createdAt', 'printInitiatedAt']);
    for (const f of frames) {
      const m = /data: (.*)/.exec(f);
      if (!m) continue;
      for (const key of Object.keys(JSON.parse(m[1]!))) expect(allowed.has(key), `SSE key ${key}`).toBe(true);
    }
    await app.close();
  });
});

describe('push token and device secrets never reach any response, audit row or log', () => {
  const TOKEN = 'fcm-token-' + 'T'.repeat(60);
  it('deep scan over owner list/rename/revoke, device me/heartbeat/orders and every audit row', async () => {
    const built = buildApp();
    const { app } = built;
    await app.ready();
    const owner = await login(app, world.a.ownerEmail);
    const d = await seedDevice(prisma, world.a.shopId, { name: 'Phone' });
    await newOrder(app, prisma, world.a);
    const put = await app.inject({ method: 'PUT', url: '/api/v1/device/push-token', headers: d.auth, payload: { token: TOKEN } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ data: { ok: true } });
    const bodies: string[] = [put.body];
    const grab = <T extends { body: string }>(r: T): T => {
      bodies.push(r.body);
      return r;
    };
    grab(await call(app, owner, 'GET', '/shop/devices'));
    grab(await call(app, owner, 'GET', '/shop/orders'));
    grab(await app.inject({ method: 'PATCH', url: `/api/v1/shop/devices/${d.device.id}`, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf }, payload: { name: 'Renamed' } }));
    grab(await app.inject({ method: 'GET', url: '/api/v1/device/me', headers: d.auth }));
    grab(await app.inject({ method: 'POST', url: '/api/v1/device/heartbeat', headers: d.auth, payload: { appVersion: '1.2.3' } }));
    grab(await app.inject({ method: 'GET', url: '/api/v1/device/orders', headers: d.auth }));
    const code = grab(await call(app, owner, 'POST', '/shop/devices/pairing-codes', {}));
    grab(await app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { code: code.json().data.code, deviceName: 'Second', platform: 'ANDROID' } }));
    grab(await call(app, owner, 'GET', '/shop/devices'));
    const rev = grab(await call(app, owner, 'POST', `/shop/devices/${d.device.id}/revoke`, {}));
    expect(rev.statusCode).toBe(200);
    grab(await call(app, owner, 'GET', '/shop/devices'));
    const dump = bodies.join('\n') + JSON.stringify(await prisma.auditLog.findMany()) + JSON.stringify(await prisma.orderStatusHistory.findMany());
    for (const needle of [TOKEN, '"pushToken"', 'credentialHash', '"osVersion"', '"pushTokenUpdatedAt"', d.secret, hashDeviceCredential(d.secret)]) {
      expect(dump, needle.slice(0, 16)).not.toContain(needle);
    }
    // revoked device: token cleared at rest as well
    expect((await prisma.shopDevice.findUniqueOrThrow({ where: { id: d.device.id } })).pushToken).toBeNull();
    await app.close();
  });
});

describe('request validation bounds and uniform pairing failures', () => {
  it('oversized bodies are rejected (413) and field bounds hold on device endpoints', async () => {
    const built = buildApp();
    const { app } = built;
    await app.ready();
    const d = await seedDevice(prisma, world.a.shopId);
    const big = await app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { code: 'x'.repeat(200_000), deviceName: 'a', platform: 'ANDROID' } });
    expect(big.statusCode).toBe(413);
    const bigHb = await app.inject({ method: 'POST', url: '/api/v1/device/heartbeat', headers: d.auth, payload: { appVersion: 'x'.repeat(200_000) } });
    expect(bigHb.statusCode).toBe(413);
    const put = (token: string) => app.inject({ method: 'PUT', url: '/api/v1/device/push-token', headers: d.auth, payload: { token } });
    expect((await put('short')).statusCode).toBe(400);
    expect((await put('x'.repeat(4097))).statusCode).toBe(400);
    expect((await put('x'.repeat(4096))).statusCode).toBe(200);
    for (const payload of [
      { code: 'PB-AAAA-BBBB', deviceName: 'x'.repeat(61), platform: 'ANDROID' },
      { code: 'PB-AAAA-BBBB', deviceName: '   ', platform: 'ANDROID' },
      { code: 'PB-AAAA-BBBB', deviceName: 'ok', platform: 'IOS' },
      { code: 'PB-AAAA-BBBB', deviceName: 'ok', platform: 'ANDROID', appVersion: 'v'.repeat(41) },
      { code: 'PB-AAAA-BBBB', deviceName: 'ok', platform: 'ANDROID', osVersion: 'v'.repeat(81) },
      { code: 'PB-AAAA-BBBB', deviceName: 'ok', platform: 'ANDROID', shopId: world.b.shopId }
    ]) {
      expect((await app.inject({ method: 'POST', url: '/api/v1/device/pair', payload })).statusCode).toBe(400);
    }
    await app.close();
  });

  it('unknown / expired / used / malformed / suspended-shop codes return byte-identical failures (modulo request id)', async () => {
    const built = buildApp();
    const { app } = built;
    await app.ready();
    const owner = await login(app, world.a.ownerEmail);
    const mk = async () => (await call(app, owner, 'POST', '/shop/devices/pairing-codes', {})).json().data.code as string;
    const used = await mk();
    const expired = await mk();
    const suspended = await mk();
    const pair = (code: string) => app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { code, deviceName: 'Tab', platform: 'ANDROID' } });
    expect((await pair(used)).statusCode).toBe(200);
    await prisma.devicePairingCode.updateMany({ where: { usedAt: null }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    // expire exactly one: find by creating order -> take the second unused row
    const rows = await prisma.devicePairingCode.findMany({ where: { usedAt: null }, orderBy: { createdAt: 'asc' } });
    await prisma.devicePairingCode.update({ where: { id: rows[0]!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    const shapes = new Map<string, string>();
    for (const [label, code] of [['unknown', 'PB-ZZZZ-ZZZZ'], ['malformed', 'nope'], ['used', used], ['expired', expired], ['suspended', suspended]] as const) {
      const r = await pair(code);
      expect(r.statusCode, label).toBe(400);
      const body = r.json();
      shapes.set(label, JSON.stringify({ ...body, error: { ...body.error, requestId: 'x' } }));
    }
    expect(new Set(shapes.values()).size).toBe(1);
    await app.close();
  });
});

describe('tenant isolation on device-side lookups', () => {
  it('another shop device cannot be reached via owner endpoints by id; owner of shop B cannot revoke shop A device', async () => {
    const { app } = await withRoutes();
    const ownerB: Session = await login(app, world.b.ownerEmail);
    const a = await seedDevice(prisma, world.a.shopId);
    expect((await call(app, ownerB, 'POST', `/shop/devices/${a.device.id}/revoke`, {})).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/shop/devices/${a.device.id}`, headers: { cookie: ownerB.cookie, 'x-csrf-token': ownerB.csrf }, payload: { name: 'pwn' } })).statusCode).toBe(404);
    const missing = await call(app, ownerB, 'POST', `/shop/devices/${randomUUID()}/revoke`, {});
    const cross = await call(app, ownerB, 'POST', `/shop/devices/${a.device.id}/revoke`, {});
    expect(JSON.stringify({ ...cross.json(), error: { ...cross.json().error, requestId: '' } })).toBe(
      JSON.stringify({ ...missing.json(), error: { ...missing.json().error, requestId: '' } })
    );
    expect((await prisma.shopDevice.findUniqueOrThrow({ where: { id: a.device.id } })).status).toBe('ACTIVE');
    await app.close();
  });
});

describe('unauthenticated floods on device-self routes are bounded per IP', () => {
  it('bogus credentials hit the per-IP ceiling (429) before costing unbounded DB lookups', async () => {
    const built = buildApp({ RATE_LIMIT_SHOP_READ_MAX: '2' }); // ceiling = 2 * 5 = 10 per minute
    const { app } = built;
    await app.ready();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      statuses.push((await app.inject({ method: 'GET', url: '/api/v1/device/me', headers: { authorization: 'Bearer pbd_' + 'Q'.repeat(43) } })).statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429, 429, 429]);
    await app.close();
  });
});
