import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advance, buildApp, call, login, newOrder, seedWorld, type Session, type World } from './api-helpers.js';

describe('two-shop tenant isolation', () => {
  const { app, prisma, events } = buildApp({ SSE_HEARTBEAT_MS: '150' });
  let world: World;
  let a: Session;
  let b: Session;
  let orderA: { id: string; documentId: string };
  let base = '';
  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
    a = await login(app, world.a.ownerEmail);
    b = await login(app, world.b.ownerEmail);
    const created = await newOrder(app, prisma, world.a);
    await advance(app, a, created.order.id, 'ACCEPTED', 'PRINTING');
    orderA = created.order;
  });

  it("B cannot read, list, access, transition, print or confirm A's order", async () => {
    expect((await call(app, b, 'GET', `/shop/orders/${orderA.id}`)).statusCode).toBe(404);
    expect((await call(app, b, 'GET', '/shop/orders')).json().data.items).toHaveLength(0);
    expect((await call(app, a, 'GET', '/shop/orders')).json().data.items).toHaveLength(1);
    expect((await call(app, b, 'POST', `/shop/orders/${orderA.id}/document-access`, {})).statusCode).toBe(404);
    const t = await call(app, b, 'POST', `/shop/orders/${orderA.id}/transitions`, { toStatus: 'CANCELLED', clientRequestId: randomUUID() });
    expect(t.statusCode).toBe(404);
    expect(t.json().error.code).toBe('ORDER_NOT_FOUND');
    // retired endpoint: 410 for any authenticated shop, and it never touches A's order
    const retired = await call(app, b, 'POST', `/shop/orders/${orderA.id}/print-confirmation`, { clientRequestId: randomUUID() });
    expect(retired.statusCode).toBe(410);
    expect(retired.json().error.code).toBe('ENDPOINT_RETIRED');
    for (const path of ['print-now', 'document-download']) {
      const r = await call(app, b, 'POST', `/shop/orders/${orderA.id}/${path}`, path === 'print-now' ? { clientRequestId: randomUUID() } : {});
      expect(r.statusCode, path).toBe(404);
    }
    const row = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id }, include: { document: true } });
    expect(row.status).toBe('PRINTING');
    expect(row.document.printedAt).toBeNull();
    expect(row.document.printInitiatedAt).toBeNull();
    expect(row.document.deleteAfter).toBeNull();
  });

  it("B cannot update, delete or even detect A's pricing rules, and settings stay separate", async () => {
    const ruleA = await prisma.pricingRule.findFirstOrThrow({ where: { shopId: world.a.shopId } });
    expect((await call(app, b, 'PUT', `/shop/pricing-rules/${ruleA.id}`, { pricePerSheetPaise: 1 })).statusCode).toBe(404);
    expect((await call(app, b, 'DELETE', `/shop/pricing-rules/${ruleA.id}`)).statusCode).toBe(404);
    expect((await prisma.pricingRule.findUniqueOrThrow({ where: { id: ruleA.id } })).pricePerSheetPaise).toBe(ruleA.pricePerSheetPaise);
    const listB = (await call(app, b, 'GET', '/shop/pricing-rules')).json().data as Array<{ id: string }>;
    expect(listB.map((r) => r.id)).not.toContain(ruleA.id);

    await call(app, b, 'PUT', '/shop/settings', { displayName: 'B Renamed' });
    expect((await call(app, a, 'GET', '/shop/settings')).json().data.displayName).toBe('Sharma Print');
    expect((await call(app, b, 'GET', '/shop/settings')).json().data.displayName).toBe('B Renamed');
    // a client-supplied shop id is rejected (strict) rather than honoured
    expect((await call(app, b, 'PUT', '/shop/settings', { shopId: world.a.shopId, displayName: 'x' })).statusCode).toBe(400);
    expect((await call(app, b, 'GET', `/shop/orders?shopId=${world.a.shopId}`)).statusCode).toBe(400);
  });

  it('SSE bus delivers strictly per shop', async () => {
    const got: Record<string, string[]> = { a: [], b: [] };
    const ua = events.subscribe(world.a.shopId, { write: (c) => got.a!.push(c), close: () => undefined });
    const ub = events.subscribe(world.b.shopId, { write: (c) => got.b!.push(c), close: () => undefined });
    await call(app, a, 'POST', `/shop/orders/${orderA.id}/print-now`, { clientRequestId: randomUUID() });
    await newOrder(app, prisma, world.a);
    expect(got.a!.join('')).toContain('order.created');
    expect(got.a!.join('')).toContain('document.deletionScheduled');
    expect(got.b!.join('')).not.toContain('event:');
    ua();
    ub();
  });

  it('real SSE stream: auth required, per-shop, heartbeat, Last-Event-ID replay, correct headers', async () => {
    expect((await fetch(`${base}/api/v1/shop/events`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/shop/events`, { headers: { cookie: 'printout_session=nope' } })).status).toBe(401);

    const lastId = events.emit(world.a.shopId, 'order.updated', { id: 'old', status: 'NEW' });
    events.emit(world.a.shopId, 'order.updated', { id: 'replayed', status: 'NEW' });
    events.emit(world.b.shopId, 'order.updated', { id: 'other-shop', status: 'NEW' });

    const controller = new AbortController();
    const res = await fetch(`${base}/api/v1/shop/events`, {
      headers: { cookie: a.cookie, 'last-event-id': String(lastId), origin: 'http://localhost:5173' },
      signal: controller.signal
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!text.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil('replayed');
    expect(text).toContain('replayed');
    expect(text).not.toContain('"old"');
    expect(text).not.toContain('other-shop');

    events.emit(world.b.shopId, 'order.created', { id: 'b-live' });
    events.emit(world.a.shopId, 'order.created', { id: 'a-live' });
    await readUntil('a-live');
    expect(text).toContain('a-live');
    expect(text).not.toContain('b-live');
    await readUntil(': ping');
    expect(text).toContain(': ping');
    // ids are monotonic
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);

    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(events.connectionCount(world.a.shopId)).toBe(0);
  });

  it('SSE stream closes after logout (session re-validated on heartbeat)', async () => {
    const res = await fetch(`${base}/api/v1/shop/events`, { headers: { cookie: a.cookie } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await call(app, a, 'POST', '/auth/logout');
    const deadline = Date.now() + 5000;
    let done = false;
    while (!done && Date.now() < deadline) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  it('platform admins and owners are separated: owner gets 403 on admin, admin gets 403 on shop routes', async () => {
    const admin = await login(app, world.adminEmail);
    expect((await call(app, a, 'GET', '/admin/dashboard')).statusCode).toBe(403);
    expect((await call(app, admin, 'GET', '/shop/orders')).statusCode).toBe(403);
    expect((await call(app, admin, 'GET', '/shop/events')).statusCode).toBe(403);
  });
});
