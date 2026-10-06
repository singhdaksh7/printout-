import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, call, login, newOrder, seedDevice, seedLegacyStatus, seedWorld, type Session, type World } from './api-helpers.js';

describe('device order API: authentication, tenancy, retention gates, payload hygiene', () => {
  const { app, prisma } = buildApp();
  let world: World;
  let owner: Session;
  let admin: Session;
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
    owner = await login(app, world.a.ownerEmail);
    admin = await login(app, world.adminEmail);
  });

  type Hdrs = Record<string, string>;
  const dev = (method: 'GET' | 'POST', url: string, headers: Hdrs, payload?: unknown) =>
    app.inject({ method, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  const routes = (id: string): Array<['GET' | 'POST', string, unknown]> => [
    ['GET', '/device/orders', undefined],
    ['GET', `/device/orders/${id}`, undefined],
    ['POST', `/device/orders/${id}/print`, { clientRequestId: randomUUID() }],
    ['POST', `/device/orders/${id}/reprint`, {}],
    ['POST', `/device/orders/${id}/download`, {}]
  ];
  const doc = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });

  it('anonymous, malformed, unknown and revoked devices are rejected on every route', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    const revoked = await seedDevice(prisma, world.a.shopId, { status: 'REVOKED' });
    for (const [m, u, b] of routes(order.id)) {
      expect((await dev(m, u, {}, b)).statusCode).toBe(401);
      expect((await dev(m, u, { authorization: 'Bearer nope' }, b)).statusCode).toBe(401);
      expect((await dev(m, u, { authorization: 'Bearer pbd_' + 'x'.repeat(43) }, b)).statusCode).toBe(401);
      const r = await dev(m, u, revoked.auth, b);
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('DEVICE_REVOKED');
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
  });

  it('a device revoked after pairing is rejected on its very next request', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    const d = await seedDevice(prisma, world.a.shopId);
    expect((await dev('GET', '/device/orders', d.auth)).statusCode).toBe(200);
    await prisma.shopDevice.update({ where: { id: d.device.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
    for (const [m, u, b] of routes(order.id)) expect((await dev(m, u, d.auth, b)).statusCode).toBe(401);
  });

  it('CANCELLED / SUSPENDED subscription -> 403 SUBSCRIPTION_INACTIVE; suspended shop -> 403 SHOP_SUSPENDED', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    const d = await seedDevice(prisma, world.a.shopId);
    for (const status of ['CANCELLED', 'SUSPENDED'] as const) {
      await prisma.subscription.update({ where: { shopId: world.a.shopId }, data: { status } });
      for (const [m, u, b] of routes(order.id)) {
        const r = await dev(m, u, d.auth, b);
        expect(r.statusCode).toBe(403);
        expect(r.json().error.code).toBe('SUBSCRIPTION_INACTIVE');
      }
    }
    await prisma.subscription.update({ where: { shopId: world.a.shopId }, data: { status: 'ACTIVE' } });
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    for (const [m, u, b] of routes(order.id)) {
      const r = await dev(m, u, d.auth, b);
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('SHOP_SUSPENDED');
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEW');
  });

  it('a device cannot read, print, reprint or download another shop order (404) and the list is tenant-scoped', async () => {
    const mine = await newOrder(app, prisma, world.a);
    const theirs = await newOrder(app, prisma, world.b);
    const d = await seedDevice(prisma, world.a.shopId);
    for (const [m, u, b] of routes(theirs.order.id).slice(1)) {
      const r = await dev(m, u, d.auth, b);
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('ORDER_NOT_FOUND');
    }
    const list = (await dev('GET', '/device/orders', d.auth)).json().data.items;
    expect(list.map((o: { id: string }) => o.id)).toEqual([mine.order.id]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: theirs.order.id } })).status).toBe('NEW');
    expect((await doc(theirs.doc.id)).printInitiatedAt).toBeNull();
  });

  it('the device cannot choose a shop: extra shopId in body/query is rejected (strict) and changes nothing', async () => {
    const theirs = await newOrder(app, prisma, world.b);
    const mine = await newOrder(app, prisma, world.a);
    const d = await seedDevice(prisma, world.a.shopId);
    expect((await dev('GET', `/device/orders?shopId=${world.b.shopId}`, d.auth)).statusCode).toBe(400);
    const p = await dev('POST', `/device/orders/${theirs.order.id}/print`, d.auth, { clientRequestId: randomUUID(), shopId: world.b.shopId });
    expect(p.statusCode).toBe(400);
    const p2 = await dev('POST', `/device/orders/${mine.order.id}/print`, d.auth, { clientRequestId: randomUUID(), shopId: world.b.shopId });
    expect(p2.statusCode).toBe(400);
    expect((await dev('POST', `/device/orders/${theirs.order.id}/reprint`, d.auth, { shopId: world.b.shopId })).statusCode).toBe(400);
    expect((await dev('POST', `/device/orders/${theirs.order.id}/download`, d.auth, { shopId: world.b.shopId })).statusCode).toBe(400);
    expect((await doc(theirs.doc.id)).printInitiatedAt).toBeNull();
    expect((await doc(mine.doc.id)).printInitiatedAt).toBeNull();
    // print requires a client request id
    expect((await dev('POST', `/device/orders/${mine.order.id}/print`, d.auth, {})).statusCode).toBe(400);
  });

  it('platform-admin / owner cookies do not work on device routes, and device credentials do not work on owner routes', async () => {
    const { order } = await newOrder(app, prisma, world.a);
    const d = await seedDevice(prisma, world.a.shopId);
    for (const [m, u, b] of routes(order.id)) {
      expect((await dev(m, u, { cookie: admin.cookie, 'x-csrf-token': admin.csrf }, b)).statusCode).toBe(401);
      expect((await dev(m, u, { cookie: owner.cookie, 'x-csrf-token': owner.csrf }, b)).statusCode).toBe(401);
    }
    const asOwner = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app.inject({ method, url: `/api/v1${url}`, headers: d.auth, ...(payload === undefined ? {} : { payload: payload as object }) });
    expect((await asOwner('GET', '/shop/orders')).statusCode).toBe(401);
    expect((await asOwner('GET', `/shop/orders/${order.id}`)).statusCode).toBe(401);
    expect((await asOwner('POST', `/shop/orders/${order.id}/print-now`, { clientRequestId: randomUUID() })).statusCode).toBe(401);
    expect((await asOwner('POST', `/shop/orders/${order.id}/document-access`, {})).statusCode).toBe(401);
    // and the platform admin session still gets no documents from the owner API
    expect((await call(app, admin, 'POST', `/shop/orders/${order.id}/document-access`, {})).statusCode).toBe(403);
  });

  it('expired (now >= deleteAfter) and DELETED documents are denied for print / reprint / download even when the object still exists', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const p = await dev('POST', `/device/orders/${o.order.id}/print`, d.auth, { clientRequestId: randomUUID() });
    expect(p.statusCode).toBe(200);
    // deadline passes; the worker has NOT run (document still PRINTED_RETENTION, object present)
    await prisma.document.update({ where: { id: o.doc.id }, data: { deleteAfter: new Date(Date.now() - 1000) } });
    const before = await doc(o.doc.id);
    for (const [m, u, b] of routes(o.order.id).slice(2)) {
      const r = await dev(m, u, d.auth, b);
      expect([409, 410]).toContain(r.statusCode);
      expect(r.json().error.code).toBe('DOCUMENT_UNAVAILABLE');
      expect(r.body).not.toMatch(/https?:\/\//);
    }
    // exactly at the boundary: deleteAfter == now is denied too
    await prisma.document.update({ where: { id: o.doc.id }, data: { deleteAfter: new Date() } });
    for (const [m, u, b] of routes(o.order.id).slice(2)) expect((await dev(m, u, d.auth, b)).statusCode).toBeGreaterThanOrEqual(409);
    // DELETED
    await prisma.document.update({ where: { id: o.doc.id }, data: { status: 'DELETED', deletedAt: new Date() } });
    for (const [m, u, b] of routes(o.order.id).slice(2)) expect((await dev(m, u, d.auth, b)).statusCode).toBeGreaterThanOrEqual(409);
    expect((await doc(o.doc.id)).printInitiatedAt?.getTime()).toBe(before.printInitiatedAt?.getTime());
  });

  it('cancelled orders and unprinted-but-expired uploads are denied', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    const c = await newOrder(app, prisma, world.a);
    await prisma.order.update({ where: { id: c.order.id }, data: { status: 'CANCELLED' } });
    for (const [m, u, b] of routes(c.order.id).slice(2)) expect((await dev(m, u, d.auth, b)).statusCode).toBeGreaterThanOrEqual(409);
    const e = await newOrder(app, prisma, world.a);
    await prisma.document.update({ where: { id: e.doc.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    for (const [m, u, b] of routes(e.order.id).slice(2)) expect((await dev(m, u, d.auth, b)).statusCode).toBeGreaterThanOrEqual(409);
    expect((await doc(e.doc.id)).printInitiatedAt).toBeNull();
  });

  it('list / detail never start retention; reprint of a never-printed order is 409 and starts nothing; download never starts retention', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const before = await doc(o.doc.id);
    expect((await dev('GET', '/device/orders', d.auth)).statusCode).toBe(200);
    expect((await dev('GET', `/device/orders/${o.order.id}`, d.auth)).statusCode).toBe(200);
    const re = await dev('POST', `/device/orders/${o.order.id}/reprint`, d.auth, {});
    expect(re.statusCode).toBe(409);
    expect(re.json().error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(re.json().error.message).toMatch(/Print the order first/);
    const dl = await dev('POST', `/device/orders/${o.order.id}/download`, d.auth, {});
    expect(dl.statusCode).toBe(200);
    expect(dl.json().data.contentDisposition).toBe('attachment');
    const after = await doc(o.doc.id);
    expect(after.status).toBe('AVAILABLE');
    expect(after.printInitiatedAt).toBeNull();
    expect(after.deleteAfter).toBeNull();
    expect(after.expiresAt?.getTime()).toBe(before.expiresAt?.getTime()); // unprinted keeps its 24h expiry
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.order.id } })).status).toBe('NEW');
  });

  it('reprint and download never move printInitiatedAt / deleteAfter and return the browser shapes', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const first = await dev('POST', `/device/orders/${o.order.id}/print`, d.auth, { clientRequestId: randomUUID() });
    expect(first.statusCode).toBe(200);
    const snap = await doc(o.doc.id);
    await new Promise((r) => setTimeout(r, 1100));
    const re = await dev('POST', `/device/orders/${o.order.id}/reprint`, d.auth, {});
    const dl = await dev('POST', `/device/orders/${o.order.id}/download`, d.auth, {});
    expect(re.statusCode).toBe(200);
    expect(dl.statusCode).toBe(200);
    expect(re.json().data).toMatchObject({ contentDisposition: 'inline', mimeType: 'application/pdf', fileName: expect.any(String) });
    expect(dl.json().data).toMatchObject({ contentDisposition: 'attachment', mimeType: 'application/pdf' });
    expect(Object.keys(re.json().data).sort()).toEqual(['contentDisposition', 'expiresAt', 'fileName', 'mimeType', 'url']);
    const after = await doc(o.doc.id);
    expect(after.printInitiatedAt?.getTime()).toBe(snap.printInitiatedAt?.getTime());
    expect(after.deleteAfter?.getTime()).toBe(snap.deleteAfter?.getTime());
    expect(new Date(re.json().data.expiresAt).getTime()).toBeLessThanOrEqual(snap.deleteAfter!.getTime());
    const audits = await prisma.auditLog.findMany({ where: { targetId: o.order.id, actorDeviceId: d.device.id } });
    expect(audits.every((a) => a.actorType === 'SHOP_DEVICE' && a.actorUserId === null)).toBe(true);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['document.access', 'document.download']));
  });

  it('legacy PRINTED / READY / COLLECTED rows are readable and reprintable until deleteAfter, then denied', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    for (const status of ['PRINTED', 'READY', 'COLLECTED'] as const) {
      const o = await newOrder(app, prisma, world.a);
      await seedLegacyStatus(prisma, o.order.id, status);
      const detail = await dev('GET', `/device/orders/${o.order.id}`, d.auth);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().data.order.status).toBe(status);
      const listed = (await dev('GET', '/device/orders?print=initiated', d.auth)).json().data.items;
      expect(listed.find((x: { id: string }) => x.id === o.order.id)?.printInitiatedAt).toBeTruthy(); // printedAt fallback
      expect((await dev('POST', `/device/orders/${o.order.id}/reprint`, d.auth, {})).statusCode).toBe(200);
      expect((await dev('POST', `/device/orders/${o.order.id}/download`, d.auth, {})).statusCode).toBe(200);
      await prisma.document.update({ where: { id: o.doc.id }, data: { deleteAfter: new Date(Date.now() - 1000) } });
      expect((await dev('POST', `/device/orders/${o.order.id}/reprint`, d.auth, {})).statusCode).toBeGreaterThanOrEqual(409);
      expect((await dev('POST', `/device/orders/${o.order.id}/download`, d.auth, {})).statusCode).toBeGreaterThanOrEqual(409);
    }
  });

  it('payloads expose the agreed fields and never an object key, bucket, storage detail or credential', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const list = await dev('GET', '/device/orders', d.auth);
    const item = list.json().data.items[0];
    for (const k of ['id', 'orderNumber', 'status', 'customerDisplayNameOrReference', 'originalFilename', 'pageCount', 'selectedPageCount', 'colourMode', 'sides', 'copies', 'paperSize', 'pageSelection', 'totalPaise', 'createdAt', 'printInitiatedAt', 'deleteAfter', 'documentStatus']) {
      expect(item).toHaveProperty(k);
    }
    const detail = await dev('GET', `/device/orders/${o.order.id}`, d.auth);
    // the same shape the owner sees (one business model)
    const ownerList = (await call(app, owner, 'GET', '/shop/orders')).json().data.items[0];
    expect(item).toEqual(ownerList);
    const printed = await dev('POST', `/device/orders/${o.order.id}/print`, d.auth, { clientRequestId: randomUUID() });
    const post = await dev('GET', '/device/orders', d.auth);
    const key = (await doc(o.doc.id)).objectKey;
    for (const res of [list, detail, post]) {
      expect(res.body).not.toContain(key);
      expect(res.body).not.toMatch(/objectKey|bucket|s3|signature|credential|secret|X-Amz/i);
    }
    // the print response intentionally carries only the temporary url (never raw key/bucket fields)
    expect(Object.keys(printed.json().data.access).sort()).toEqual(['contentDisposition', 'expiresAt', 'mimeType', 'url']);
    expect(JSON.stringify({ ...printed.json().data, access: undefined })).not.toMatch(/objectKey|bucket|signature/i);
  });
});
