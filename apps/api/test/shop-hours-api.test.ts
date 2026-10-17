import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, call, createDocument, login, placeOrder, quoteFor, seedWorld, type Session, type World } from './api-helpers.js';
import { emptyWeek } from '../src/domain/hours.js';

const ALL_DAY = { start: '00:00', end: '24:00' };
const alwaysOpen = () => Object.fromEntries(Object.keys(emptyWeek()).map((d) => [d, [ALL_DAY]]));
const alwaysClosed = () => emptyWeek();

describe('shop operating hours API', () => {
  const { app, prisma } = buildApp();
  let world: World;
  let a: Session;
  let b: Session;
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
    a = await login(app, world.a.ownerEmail);
    b = await login(app, world.b.ownerEmail);
  });

  const putHours = (s: Session, body: unknown) => call(app, s, 'PUT', '/shop/hours', body);
  const publicShop = async (slug: string) => (await app.inject({ method: 'GET', url: `/api/v1/public/shops/${slug}` })).json().data;
  const order = async (slug: string, shopId: string) => {
    const doc = await createDocument(prisma, shopId);
    const q = await quoteFor(app, slug, doc.id);
    return { doc, q, o: q.statusCode === 200 ? await placeOrder(app, slug, q.json().data.quoteId) : null };
  };

  describe('defaults and backward compatibility', () => {
    it('existing shop: no schedule, ACCEPT, UTC-free IST default, availability unknown, ordering unchanged', async () => {
      const res = await call(app, a, 'GET', '/shop/hours');
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ timezone: 'Asia/Kolkata', weeklyHours: null, specialClosures: [], afterHoursPolicy: 'ACCEPT', temporaryClosure: null, reopenUntil: null, availability: { state: 'unknown', reason: 'not_configured', orderingBlocked: false } });
      const shop = await publicShop(world.a.slug);
      expect(shop.availability).toMatchObject({ state: 'unknown', orderingBlocked: false, weeklyHours: null });
      expect(shop.acceptsOrders).toBe(true);
      expect((await order(world.a.slug, world.a.shopId)).o?.statusCode).toBe(200);
    });
    it('a shop with no ShopSettings row is handled', async () => {
      await prisma.shopSettings.delete({ where: { shopId: world.a.shopId } });
      expect((await call(app, a, 'GET', '/shop/hours')).json().data.availability.state).toBe('unknown');
      expect((await order(world.a.slug, world.a.shopId)).o?.statusCode).toBe(200);
      expect((await putHours(a, { afterHoursPolicy: 'BLOCK' })).statusCode).toBe(200);
    });
    it('saving ordinary settings never touches hours', async () => {
      await putHours(a, { weeklyHours: alwaysClosed(), afterHoursPolicy: 'BLOCK', specialClosures: [{ date: '2030-01-01', reason: 'NY' }] });
      const r = await call(app, a, 'PUT', '/shop/settings', { publicContact: '99999', brandColor: '#112233' });
      expect(r.statusCode).toBe(200);
      const h = (await call(app, a, 'GET', '/shop/hours')).json().data;
      expect(h).toMatchObject({ afterHoursPolicy: 'BLOCK', specialClosures: [{ date: '2030-01-01', reason: 'NY' }] });
      expect(h.weeklyHours.mon).toEqual([]);
    });
  });

  describe('authentication and tenant isolation', () => {
    it('rejects unauthenticated requests', async () => {
      for (const [m, u, body] of [['GET', '/shop/hours'], ['PUT', '/shop/hours', {}], ['PUT', '/shop/hours/temporary-closure', {}], ['DELETE', '/shop/hours/temporary-closure'], ['POST', '/shop/hours/reopen', { minutes: 30 }], ['DELETE', '/shop/hours/reopen']] as const) {
        expect((await call(app, null, m, u, body)).statusCode, `${m} ${u}`).toBe(401);
      }
    });
    it('requires CSRF on mutations', async () => {
      const res = await app.inject({ method: 'PUT', url: '/api/v1/shop/hours', headers: { cookie: a.cookie }, payload: { afterHoursPolicy: 'BLOCK' } });
      expect(res.statusCode).toBe(403);
    });
    it('a platform admin cannot use the shop endpoints', async () => {
      const admin = await login(app, world.adminEmail);
      expect((await call(app, admin, 'GET', '/shop/hours')).statusCode).toBe(403);
    });
    it('shop A cannot modify shop B (writes always target the session shop)', async () => {
      expect((await putHours(a, { weeklyHours: alwaysClosed(), afterHoursPolicy: 'BLOCK' })).statusCode).toBe(200);
      await call(app, a, 'PUT', '/shop/hours/temporary-closure', { reason: 'A only' });
      await call(app, a, 'POST', '/shop/hours/reopen', { minutes: 30 });
      const bView = (await call(app, b, 'GET', '/shop/hours')).json().data;
      expect(bView).toMatchObject({ weeklyHours: null, afterHoursPolicy: 'ACCEPT', temporaryClosure: null, reopenUntil: null });
      // A tenant id in the body is rejected (strict) rather than honoured.
      expect((await putHours(a, { shopId: world.b.shopId, afterHoursPolicy: 'BLOCK' })).statusCode).toBe(400);
      expect((await prisma.shopSettings.findUniqueOrThrow({ where: { shopId: world.b.shopId } })).afterHoursPolicy).toBe('ACCEPT');
    });
    it('writes are audited with the actor, not the content of reasons', async () => {
      await putHours(a, { afterHoursPolicy: 'BLOCK' });
      const log = await prisma.auditLog.findFirst({ where: { shopId: world.a.shopId, action: 'shop.hours.update' } });
      expect(log?.actorUserId).toBe(a.userId);
    });
  });

  describe('validation', () => {
    it.each([
      ['overlap', { weeklyHours: { ...alwaysClosed(), mon: [{ start: '09:00', end: '13:00' }, { start: '12:00', end: '17:00' }] } }],
      ['start === end', { weeklyHours: { ...alwaysClosed(), mon: [{ start: '09:00', end: '09:00' }] } }],
      ['bad time', { weeklyHours: { ...alwaysClosed(), mon: [{ start: '9am', end: '17:00' }] } }],
      ['missing day', { weeklyHours: { mon: [] } }],
      ['unknown timezone', { timezone: 'Mars/Olympus' }],
      ['bad policy', { afterHoursPolicy: 'MAYBE' }],
      ['impossible date', { specialClosures: [{ date: '2026-02-30' }] }],
      ['duplicate date', { specialClosures: [{ date: '2026-12-25' }, { date: '2026-12-25' }] }],
      ['empty body', {}],
      ['unknown field', { nope: 1 }]
    ])('rejects %s with 400 and does not change anything', async (_n, body) => {
      await putHours(a, { afterHoursPolicy: 'BLOCK' });
      const res = await putHours(a, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect((await call(app, a, 'GET', '/shop/hours')).json().data.afterHoursPolicy).toBe('BLOCK');
    });
    it('partial updates leave omitted fields untouched; weeklyHours:null removes the schedule explicitly', async () => {
      await putHours(a, { weeklyHours: alwaysOpen(), specialClosures: [{ date: '2030-05-05' }] });
      await putHours(a, { afterHoursPolicy: 'BLOCK' });
      let h = (await call(app, a, 'GET', '/shop/hours')).json().data;
      expect(h.weeklyHours.mon).toEqual([ALL_DAY]);
      expect(h.specialClosures).toHaveLength(1);
      await putHours(a, { weeklyHours: null });
      h = (await call(app, a, 'GET', '/shop/hours')).json().data;
      expect(h.weeklyHours).toBeNull();
      expect(h.specialClosures).toHaveLength(1);
    });
    it('accepts overnight and multi-interval days', async () => {
      const res = await putHours(a, { weeklyHours: { ...alwaysClosed(), fri: [{ start: '09:00', end: '13:00' }, { start: '21:00', end: '02:00' }] } });
      expect(res.statusCode).toBe(200);
    });
    it('temporary closure: until must be in the future; reopen minutes bounded', async () => {
      expect((await call(app, a, 'PUT', '/shop/hours/temporary-closure', { until: '2020-01-01T00:00:00Z' })).statusCode).toBe(400);
      expect((await call(app, a, 'POST', '/shop/hours/reopen', { minutes: 1 })).statusCode).toBe(400);
      expect((await call(app, a, 'POST', '/shop/hours/reopen', { minutes: 99999 })).statusCode).toBe(400);
    });
  });

  describe('after-hours ordering policy', () => {
    it('ACCEPT: closed shop still takes orders', async () => {
      await putHours(a, { weeklyHours: alwaysClosed(), afterHoursPolicy: 'ACCEPT' });
      expect((await publicShop(world.a.slug)).availability).toMatchObject({ state: 'closed', orderingBlocked: false });
      expect((await order(world.a.slug, world.a.shopId)).o?.statusCode).toBe(200);
    });
    it('BLOCK: closed shop rejects quotes, orders and uploads with SHOP_CLOSED; open shop accepts', async () => {
      await putHours(a, { weeklyHours: alwaysClosed(), afterHoursPolicy: 'BLOCK' });
      const doc = await createDocument(prisma, world.a.shopId);
      const q = await quoteFor(app, world.a.slug, doc.id);
      expect(q.statusCode).toBe(409);
      expect(q.json().error.code).toBe('SHOP_CLOSED');
      const init = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/uploads/initiate`, payload: { fileName: 'a.pdf', declaredMimeType: 'application/pdf', byteSize: 1000 } });
      expect(init.statusCode).toBe(409);
      expect(init.json().error.code).toBe('SHOP_CLOSED');
      expect((await publicShop(world.a.slug)).availability).toMatchObject({ state: 'closed', orderingBlocked: true });
      await putHours(a, { weeklyHours: alwaysOpen() });
      expect((await order(world.a.slug, world.a.shopId)).o?.statusCode).toBe(200);
    });
    it('BLOCK with no schedule never blocks (availability unknown)', async () => {
      await putHours(a, { afterHoursPolicy: 'BLOCK' });
      expect((await order(world.a.slug, world.a.shopId)).o?.statusCode).toBe(200);
    });
    it('BLOCK on shop A does not affect shop B', async () => {
      await putHours(a, { weeklyHours: alwaysClosed(), afterHoursPolicy: 'BLOCK' });
      expect((await order(world.b.slug, world.b.shopId)).o?.statusCode).toBe(200);
    });
    it('special closure today blocks; temporary closure blocks and clears; emergency reopen overrides', async () => {
      await putHours(a, { weeklyHours: alwaysOpen(), afterHoursPolicy: 'BLOCK' });
      const today = (await call(app, a, 'GET', '/shop/hours')).json().data.availability.serverTime.slice(0, 10);
      // Use a window wide enough to cover "today" in IST whatever the UTC date is.
      await putHours(a, { specialClosures: [{ date: today, reason: 'x' }, { date: new Date(Date.parse(today) + 86400e3).toISOString().slice(0, 10) }, { date: new Date(Date.parse(today) - 86400e3).toISOString().slice(0, 10) }] });
      expect((await order(world.a.slug, world.a.shopId)).q.statusCode).toBe(409);
      const re = await call(app, a, 'POST', '/shop/hours/reopen', { minutes: 30 });
      expect(re.json().data.availability).toMatchObject({ state: 'open', reason: 'emergency_reopen' });
      expect((await order(world.a.slug, world.a.shopId)).o?.statusCode).toBe(200);
      await putHours(a, { specialClosures: [] });
      const tc = await call(app, a, 'PUT', '/shop/hours/temporary-closure', { reason: 'Lunch', until: new Date(Date.now() + 3600e3).toISOString() });
      expect(tc.json().data).toMatchObject({ reopenUntil: null, availability: { state: 'closed', reason: 'temporary_closure', closureReason: 'Lunch' } });
      const pub = (await publicShop(world.a.slug)).availability;
      expect(pub).toMatchObject({ state: 'closed', orderingBlocked: true, temporaryClosure: { reason: 'Lunch' } });
      expect((await order(world.a.slug, world.a.shopId)).q.statusCode).toBe(409);
      expect((await call(app, a, 'DELETE', '/shop/hours/temporary-closure')).json().data.availability.state).toBe('open');
      expect((await order(world.a.slug, world.a.shopId)).o?.statusCode).toBe(200);
    });
    it('closing between quote and order blocks the order (race at the boundary); the document stays unused', async () => {
      await putHours(a, { weeklyHours: alwaysOpen(), afterHoursPolicy: 'BLOCK' });
      const doc = await createDocument(prisma, world.a.shopId);
      const q = await quoteFor(app, world.a.slug, doc.id);
      expect(q.statusCode).toBe(200);
      await call(app, a, 'PUT', '/shop/hours/temporary-closure', { reason: 'Closing early' });
      const o = await placeOrder(app, world.a.slug, q.json().data.quoteId);
      expect(o.statusCode).toBe(409);
      expect(o.json().error.code).toBe('SHOP_CLOSED');
      expect(await prisma.order.count()).toBe(0);
      // Counter was not consumed by the rejected attempt (rolled back).
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: world.a.shopId } })).orderCounter).toBe(0);
      await call(app, a, 'DELETE', '/shop/hours/temporary-closure');
      expect((await placeOrder(app, world.a.slug, q.json().data.quoteId)).statusCode).toBe(200);
    });
    it('concurrent orders and a closing request never create an order after the closure is committed', async () => {
      await putHours(a, { weeklyHours: alwaysOpen(), afterHoursPolicy: 'BLOCK' });
      const quotes = [];
      for (let i = 0; i < 6; i++) {
        const doc = await createDocument(prisma, world.a.shopId);
        quotes.push((await quoteFor(app, world.a.slug, doc.id)).json().data.quoteId as string);
      }
      const results = await Promise.all([
        ...quotes.slice(0, 3).map((q) => placeOrder(app, world.a.slug, q)),
        call(app, a, 'PUT', '/shop/hours/temporary-closure', { reason: 'now' }),
        ...quotes.slice(3).map((q) => placeOrder(app, world.a.slug, q))
      ]);
      expect(results[3]!.statusCode).toBe(200);
      const orderResults = results.filter((_r, i) => i !== 3);
      for (const r of orderResults) expect([200, 409]).toContain(r.statusCode);
      // Every 200 is a committed order and every 409 left nothing behind (no half-written orders or burnt counters).
      const created = orderResults.filter((r) => r.statusCode === 200).length;
      expect(await prisma.order.count()).toBe(created);
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: world.a.shopId } })).orderCounter).toBe(created);
      // After the closure every new attempt is rejected.
      const doc = await createDocument(prisma, world.a.shopId);
      expect((await quoteFor(app, world.a.slug, doc.id)).statusCode).toBe(409);
    });
    it('idempotent replay of an already-created order still succeeds after closing', async () => {
      await putHours(a, { weeklyHours: alwaysOpen(), afterHoursPolicy: 'BLOCK' });
      const doc = await createDocument(prisma, world.a.shopId);
      const q = (await quoteFor(app, world.a.slug, doc.id)).json().data.quoteId as string;
      const clientRequestId = crypto.randomUUID();
      const first = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/orders`, payload: { quoteId: q, clientRequestId } });
      expect(first.statusCode).toBe(200);
      await call(app, a, 'PUT', '/shop/hours/temporary-closure', {});
      const replay = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/orders`, payload: { quoteId: q, clientRequestId } });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().data.trackingToken).toBe(first.json().data.trackingToken);
    });
  });

  describe('existing orders are unaffected by closing', () => {
    it('tracking works, status unchanged, shop can still manage the order, while closed+BLOCK', async () => {
      await putHours(a, { weeklyHours: alwaysOpen(), afterHoursPolicy: 'BLOCK' });
      const { o } = await order(world.a.slug, world.a.shopId);
      const token = o!.json().data.trackingToken as string;
      await putHours(a, { weeklyHours: alwaysClosed() });
      const t = await app.inject({ method: 'GET', url: `/api/v1/public/orders/${token}` });
      expect(t.statusCode).toBe(200);
      expect(t.json().data.status).toBe('NEW');
      const list = await call(app, a, 'GET', '/shop/orders');
      expect(list.statusCode).toBe(200);
      expect(JSON.stringify(list.json())).toContain(o!.json().data.orderNumber);
      expect(await prisma.order.count({ where: { status: 'CANCELLED' } })).toBe(0);
    });
    it('public payload exposes no private data', async () => {
      await putHours(a, { weeklyHours: alwaysOpen() });
      const raw = JSON.stringify(await publicShop(world.a.slug));
      expect(raw).not.toMatch(/shopId|ownerEmail|passwordHash|objectKey/);
    });
  });
});
