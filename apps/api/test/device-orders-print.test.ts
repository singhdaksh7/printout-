import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, call, login, newOrder, seedDevice, seedWorld, type Session, type World } from './api-helpers.js';

describe('device + browser print: one engine, one retention window, shared SSE', () => {
  const { app, prisma, events, config, storage } = buildApp();
  let world: World;
  let owner: Session;
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
    owner = await login(app, world.a.ownerEmail);
  });

  const devPrint = (auth: Record<string, string>, id: string) =>
    app.inject({ method: 'POST', url: `/api/v1/device/orders/${id}/print`, headers: auth, payload: { clientRequestId: randomUUID() } });
  const browserPrint = (id: string) => call(app, owner, 'POST', `/shop/orders/${id}/print-now`, { clientRequestId: randomUUID() });
  const doc = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });
  const edges = async (orderId: string) =>
    (await prisma.orderStatusHistory.findMany({ where: { orderId, fromStatus: { not: null } }, orderBy: { createdAt: 'asc' } })).map((h) => `${h.fromStatus}->${h.toStatus}`);
  const audits = (orderId: string, action: string) => prisma.auditLog.findMany({ where: { targetId: orderId, action } });

  async function expectSingleWindow(orderId: string, docId: string, results: Array<{ statusCode: number; json(): { data: { firstPrint: boolean; order: { status: string }; document: { printInitiatedAt: string; deleteAfter: string } } } }>) {
    expect(results.map((r) => r.statusCode).every((c) => c === 200)).toBe(true);
    const winners = results.filter((r) => r.json().data.firstPrint);
    expect(winners).toHaveLength(1);
    const d = await doc(docId);
    expect(d.status).toBe('PRINTED_RETENTION');
    expect(d.printedAt).toBeNull();
    expect(d.deleteAfter!.getTime() - d.printInitiatedAt!.getTime()).toBe(config.PRINT_RETENTION_MINUTES * 60_000);
    // every response (winner or loser) reports the same, final timestamps
    for (const r of results) {
      const body = r.json().data;
      expect(body.order.status).toBe('PRINTING');
      expect(new Date(body.document.printInitiatedAt).getTime()).toBe(d.printInitiatedAt!.getTime());
      expect(new Date(body.document.deleteAfter).getTime()).toBe(d.deleteAfter!.getTime());
    }
    expect(await edges(orderId)).toEqual(['NEW->ACCEPTED', 'ACCEPTED->PRINTING']);
    expect(await audits(orderId, 'order.printInitiated')).toHaveLength(1);
    expect(await audits(orderId, 'order.printNow')).toHaveLength(results.length);
    return d;
  }

  it('browser print and device print at the same moment: exactly one window, one history path, one printInitiated audit', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const results = await Promise.all([browserPrint(o.order.id), devPrint(d.auth, o.order.id)]);
    await expectSingleWindow(o.order.id, o.doc.id, results);
  });

  it('two different devices printing simultaneously: exactly one window and history path', async () => {
    const d1 = await seedDevice(prisma, world.a.shopId, { name: 'Phone' });
    const d2 = await seedDevice(prisma, world.a.shopId, { name: 'PC', platform: 'WINDOWS' });
    const o = await newOrder(app, prisma, world.a);
    const results = await Promise.all([devPrint(d1.auth, o.order.id), devPrint(d2.auth, o.order.id)]);
    const final = await expectSingleWindow(o.order.id, o.doc.id, results);
    // history rows record exactly one device actor per row
    const hist = await prisma.orderStatusHistory.findMany({ where: { orderId: o.order.id, fromStatus: { not: null } } });
    expect(hist.every((h) => h.reason === 'Print' && h.actorUserId === null && [d1.device.id, d2.device.id].includes(h.actorDeviceId!))).toBe(true);
    expect(final.printInitiatedAt).not.toBeNull();
  });

  it('N parallel prints from browser + several devices: one window, every loser gets a valid reopen with unchanged timestamps', async () => {
    const devices = await Promise.all([0, 1, 2].map((i) => seedDevice(prisma, world.a.shopId, { name: `D${i}` })));
    const o = await newOrder(app, prisma, world.a);
    const calls = [
      ...devices.flatMap((d) => [devPrint(d.auth, o.order.id), devPrint(d.auth, o.order.id)]),
      browserPrint(o.order.id),
      browserPrint(o.order.id),
      browserPrint(o.order.id)
    ];
    const results = await Promise.all(calls);
    await expectSingleWindow(o.order.id, o.doc.id, results);
    for (const r of results) {
      const data = r.json().data;
      expect(data.access.contentDisposition).toBe('inline');
      expect(typeof data.access.url).toBe('string');
      expect(new Date(data.access.expiresAt).getTime()).toBeLessThanOrEqual(new Date(data.document.deleteAfter).getTime());
    }
  });

  it('a device print after a browser print reuses the same deadline, and vice versa', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    const o1 = await newOrder(app, prisma, world.a);
    const b1 = await browserPrint(o1.order.id);
    expect(b1.json().data.firstPrint).toBe(true);
    const snap1 = await doc(o1.doc.id);
    await new Promise((r) => setTimeout(r, 1100));
    const d1 = await devPrint(d.auth, o1.order.id);
    expect(d1.statusCode).toBe(200);
    expect(d1.json().data).toMatchObject({ firstPrint: false, transitioned: false });
    const after1 = await doc(o1.doc.id);
    expect(after1.printInitiatedAt?.getTime()).toBe(snap1.printInitiatedAt?.getTime());
    expect(after1.deleteAfter?.getTime()).toBe(snap1.deleteAfter?.getTime());

    const o2 = await newOrder(app, prisma, world.a);
    const d2 = await devPrint(d.auth, o2.order.id);
    expect(d2.json().data.firstPrint).toBe(true);
    const snap2 = await doc(o2.doc.id);
    await new Promise((r) => setTimeout(r, 1100));
    const b2 = await browserPrint(o2.order.id);
    expect(b2.json().data).toMatchObject({ firstPrint: false, transitioned: false });
    const after2 = await doc(o2.doc.id);
    expect(after2.printInitiatedAt?.getTime()).toBe(snap2.printInitiatedAt?.getTime());
    expect(after2.deleteAfter?.getTime()).toBe(snap2.deleteAfter?.getTime());
    expect(await audits(o2.order.id, 'order.printInitiated')).toHaveLength(1);
  });

  it('device print records the device as actor (history, audit) and returns the browser print shape', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const res = await devPrint(d.auth, o.order.id);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(Object.keys(data).sort()).toEqual(['access', 'document', 'firstPrint', 'order', 'transitioned']);
    expect(data.order).toEqual({ id: o.order.id, orderNumber: o.order.orderNumber, status: 'PRINTING' });
    expect(data.transitioned).toBe(true);
    expect(Object.keys(data.document).sort()).toEqual(['deleteAfter', 'printInitiatedAt', 'status']);
    expect(data.access.contentDisposition).toBe('inline');
    const hist = await prisma.orderStatusHistory.findMany({ where: { orderId: o.order.id, fromStatus: { not: null } } });
    expect(hist).toHaveLength(2);
    expect(hist.every((h) => h.actorDeviceId === d.device.id && h.actorUserId === null && h.reason === 'Print')).toBe(true);
    const all = await prisma.auditLog.findMany({ where: { targetId: o.order.id } });
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.every((a) => a.actorType === 'SHOP_DEVICE' && a.actorDeviceId === d.device.id && a.actorUserId === null && a.shopId === world.a.shopId)).toBe(true);
    // browser actor rows are tagged SHOP_OWNER
    const o2 = await newOrder(app, prisma, world.a);
    await browserPrint(o2.order.id);
    const ownerRows = await prisma.auditLog.findMany({ where: { targetId: o2.order.id } });
    expect(ownerRows.every((a) => a.actorType === 'SHOP_OWNER' && a.actorUserId === owner.userId && a.actorDeviceId === null)).toBe(true);
    // the first print caps the link to the retention window
    expect(new Date(data.access.expiresAt).getTime()).toBeLessThanOrEqual(new Date(data.document.deleteAfter).getTime());
  });

  it('device print emits the same shop-scoped SSE events as a browser print; the other shop receives nothing', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const seen = (sink: string[]) => ({ write: (c: string) => { const m = /event: (\S+)/.exec(c); if (m) sink.push(m[1]!); }, close: () => undefined });
    const a: string[] = [];
    const b: string[] = [];
    const offA = events.subscribe(world.a.shopId, seen(a));
    const offB = events.subscribe(world.b.shopId, seen(b));
    try {
      expect((await devPrint(d.auth, o.order.id)).statusCode).toBe(200);
      expect(a).toEqual(expect.arrayContaining(['order.statusChanged', 'order.updated', 'document.deletionScheduled']));
      expect(b).toEqual([]);
      const before = a.length;
      expect((await devPrint(d.auth, o.order.id)).statusCode).toBe(200); // retry: no new events
      const re = await app.inject({ method: 'POST', url: `/api/v1/device/orders/${o.order.id}/reprint`, headers: d.auth, payload: {} });
      expect(re.statusCode).toBe(200);
      expect(a.length).toBe(before);
      expect(b).toEqual([]);
    } finally {
      offA();
      offB();
    }
  });

  it('a failure to produce the access URL starts no retention and writes nothing', async () => {
    const d = await seedDevice(prisma, world.a.shopId);
    const o = await newOrder(app, prisma, world.a);
    const spy = vi.spyOn(storage, 'temporaryReadUrl').mockRejectedValueOnce(new Error('storage down'));
    const res = await devPrint(d.auth, o.order.id);
    spy.mockRestore();
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    const after = await doc(o.doc.id);
    expect(after.printInitiatedAt).toBeNull();
    expect(after.deleteAfter).toBeNull();
    expect(after.status).toBe('AVAILABLE');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.order.id } })).status).toBe('NEW');
    expect(await audits(o.order.id, 'order.printInitiated')).toHaveLength(0);
    // a cancelled order is not printable either
    await prisma.order.update({ where: { id: o.order.id }, data: { status: 'CANCELLED' } });
    expect((await devPrint(d.auth, o.order.id)).statusCode).toBe(409);
    expect((await doc(o.doc.id)).printInitiatedAt).toBeNull();
  });
});
