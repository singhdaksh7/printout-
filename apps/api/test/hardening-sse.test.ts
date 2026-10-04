import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import { testPrisma } from './helpers/db.js';
import { login, seedWorld, testConfig, type Session, type World } from './api-helpers.js';

const prisma = testPrisma();
let world: World;
let closeApp: (() => Promise<void>) | undefined;
const open: http.ClientRequest[] = [];

beforeEach(async () => {
  world = await seedWorld(prisma);
});
afterEach(async () => {
  for (const r of open.splice(0)) r.destroy();
  await closeApp?.();
  closeApp = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(overrides: Record<string, string> = {}, httpOptions?: AppDeps['http']) {
  const built = createApp({ config: testConfig(overrides), prisma, http: httpOptions });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  closeApp = () => built.app.close();
  const port = (built.app.server.address() as AddressInfo).port;
  return { ...built, port };
}

interface Stream {
  req: http.ClientRequest;
  status: number;
  headers: http.IncomingHttpHeaders;
  ended: () => boolean;
  text: () => string;
}

function connect(port: number, session: Session | null, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let ended = false;
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/v1/shop/events', headers: { ...(session ? { cookie: session.cookie } : {}), ...headers } },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (c: string) => chunks.push(c));
        res.on('end', () => (ended = true));
        res.on('close', () => (ended = true));
        resolve({ req, status: res.statusCode!, headers: res.headers, ended: () => ended, text: () => chunks.join('') });
      }
    );
    req.on('error', reject);
    open.push(req);
  });
}

describe('SSE production behaviour (real sockets)', () => {
  it('sends proxy-safe headers, a retry hint and periodic heartbeat comments', async () => {
    const { app, port } = await start({ SSE_HEARTBEAT_MS: '100' });
    const session = await login(app, world.a.ownerEmail);
    const s = await connect(port, session);
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(s.headers['cache-control']).toMatch(/no-store/);
    expect(s.headers['cache-control']).toMatch(/no-transform/);
    expect(s.headers['x-accel-buffering']).toBe('no');
    expect(String(s.headers.connection).toLowerCase()).toBe('keep-alive');
    await sleep(450);
    expect(s.text()).toContain('retry: 3000');
    expect(s.text().match(/: ping/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('production-style config caps the heartbeat at 25s (below proxy idle timeouts)', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig({ ...process.env } as NodeJS.ProcessEnv).SSE_HEARTBEAT_MS).toBe(25_000);
    expect(() =>
      loadConfig({
        ...process.env,
        NODE_ENV: 'production',
        SSE_HEARTBEAT_MS: '30000'
      } as NodeJS.ProcessEnv)
    ).toThrow(/SSE_HEARTBEAT_MS/);
  });

  it('streams outlive Node requestTimeout and keepAliveTimeout, and still deliver events afterwards', async () => {
    const { app, port, events } = await start(
      { SSE_HEARTBEAT_MS: '150' },
      { requestTimeout: 300, keepAliveTimeout: 200, connectionsCheckingInterval: 50 }
    );
    const session = await login(app, world.a.ownerEmail);
    const s = await connect(port, session);
    await sleep(1800); // 6x requestTimeout
    expect(s.ended()).toBe(false);
    events.emit(world.a.shopId, 'order.updated', { id: 'late', status: 'NEW' });
    await sleep(100);
    expect(s.text()).toContain('"id":"late"');
  });

  it('delivers strictly per shop and replays from Last-Event-ID', async () => {
    const { app, port, events } = await start();
    const a = await login(app, world.a.ownerEmail);
    const b = await login(app, world.b.ownerEmail);
    const first = events.emit(world.a.shopId, 'order.updated', { id: 'a1' });
    events.emit(world.a.shopId, 'order.updated', { id: 'a2' });
    events.emit(world.b.shopId, 'order.updated', { id: 'b1' });
    const sa = await connect(port, a, { 'last-event-id': String(first) });
    const sb = await connect(port, b);
    await sleep(100);
    expect(sa.text()).toContain('"id":"a2"');
    expect(sa.text()).not.toContain('"id":"a1"');
    expect(sa.text()).not.toContain('b1');
    expect(sb.text()).not.toContain('"id":"a');
    expect(sb.text()).not.toContain('b1'); // no Last-Event-ID => no replay
  });

  it('re-checks authorization on connect: anonymous 401, admin 403, never a stream', async () => {
    const { app, port } = await start();
    const admin = await login(app, world.adminEmail);
    expect((await connect(port, null)).status).toBe(401);
    const forbidden = await connect(port, admin);
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers['content-type']).not.toMatch(/event-stream/);
  });

  it('closes an open stream when the shop is suspended (checked on the heartbeat)', async () => {
    const { app, port, events } = await start({ SSE_HEARTBEAT_MS: '100' });
    const session = await login(app, world.a.ownerEmail);
    const s = await connect(port, session);
    await sleep(150);
    expect(events.connectionCount(world.a.shopId)).toBe(1);
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    await sleep(500);
    expect(s.ended()).toBe(true);
    expect(events.connectionCount(world.a.shopId)).toBe(0);
  });

  it('caps concurrent streams per shop and releases the slot on client disconnect', async () => {
    const { app, port, events } = await start({ SSE_MAX_CONNECTIONS_PER_SHOP: '2' });
    const session = await login(app, world.a.ownerEmail);
    const other = await login(app, world.b.ownerEmail);
    const one = await connect(port, session);
    await connect(port, session);
    expect(events.connectionCount(world.a.shopId)).toBe(2);
    const third = await connect(port, session);
    expect(third.status).toBe(429);
    expect(third.text()).toContain('RATE_LIMITED');
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // another shop is unaffected
    expect((await connect(port, other)).status).toBe(200);
    // a closed stream frees its slot
    one.req.destroy();
    await sleep(200);
    expect(events.connectionCount(world.a.shopId)).toBe(1);
    expect((await connect(port, session)).status).toBe(200);
  });

  it('rate-limits connection attempts per session with Retry-After', async () => {
    const { app, port } = await start({ RATE_LIMIT_SSE_CONNECT_MAX: '3', SSE_MAX_CONNECTIONS_PER_SHOP: '50' });
    const session = await login(app, world.a.ownerEmail);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await connect(port, session);
      statuses.push(s.status);
      if (s.status === 429) expect(Number(s.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      s.req.destroy();
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('shutdown (app.close) ends open streams', async () => {
    const { app, port } = await start();
    const session = await login(app, world.a.ownerEmail);
    const s = await connect(port, session);
    await closeApp!();
    closeApp = undefined;
    await sleep(100);
    expect(s.ended()).toBe(true);
  });
});
