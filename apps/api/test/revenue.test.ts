import { OrderStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paiseToInr, pctChange, previousRange, resolveRevenueRange } from '../src/domain/revenue.js';
import { buildApp, call, login, newOrder, seedWorld, type Session, type World } from './api-helpers.js';

/** 2026-03-10 IST = 2026-03-09T18:30:00Z .. 2026-03-10T18:29:59.999Z. */
const AT = {
  prevEnd: '2026-03-09T18:29:59.999Z', // 09 Mar 23:59:59.999 IST
  start: '2026-03-09T18:30:00.000Z', // 10 Mar 00:00 IST
  end: '2026-03-10T18:29:59.999Z', // 10 Mar 23:59:59.999 IST
  next: '2026-03-10T18:30:00.000Z' // 11 Mar 00:00 IST
};
const REV = '/shop/analytics/revenue';

describe('revenue dashboard API', () => {
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

  interface Spec {
    at: string;
    paise: number;
    status?: OrderStatus;
    colour?: string;
    sides?: string;
    pages?: number | null;
    copies?: number;
    started?: boolean;
  }
  /** Real order pipeline, then pin the stored snapshot fields so expectations are exact. */
  async function seed(shop: { shopId: string; slug: string }, s: Spec) {
    const o = await newOrder(app, prisma, shop);
    const price = { ...(o.order.priceSnapshot as object) } as Record<string, unknown>;
    if (s.pages === null) delete price.selectedPageCount;
    else price.selectedPageCount = s.pages ?? 2;
    await prisma.order.update({
      where: { id: o.order.id },
      data: {
        createdAt: new Date(s.at),
        status: s.status ?? OrderStatus.NEW,
        totalPaise: s.paise,
        priceSnapshot: price as object,
        printOptionsSnapshot: { paperSize: 'A4', colourMode: s.colour ?? 'bw', sides: s.sides ?? 'single', copies: s.copies ?? 1, pageSelection: { mode: 'all' } }
      }
    });
    if (s.started) await prisma.document.update({ where: { id: o.doc.id }, data: { printInitiatedAt: new Date(s.at) } });
    return o.order;
  }
  const rev = async (s: Session | null, qs = '?from=2026-03-10&to=2026-03-10') => call(app, s, 'GET', `${REV}${qs}`);
  const data = async (qs?: string) => (await rev(a, qs)).json().data;

  it('requires a shop-owner session', async () => {
    const admin = await login(app, world.adminEmail);
    for (const path of [REV, `${REV}/export.csv`]) {
      expect((await call(app, null, 'GET', path)).statusCode).toBe(401);
      expect((await call(app, admin, 'GET', path)).statusCode).toBe(403);
    }
  });

  it('computes estimated value, pages, average and counts from stored quotes, excluding cancelled and expired', async () => {
    await seed(world.a, { at: AT.start, paise: 1250, pages: 5, copies: 2, started: true, colour: 'colour' });
    await seed(world.a, { at: AT.end, paise: 750, pages: 3, status: OrderStatus.PRINTING, started: true });
    await seed(world.a, { at: AT.end, paise: 999, pages: 9, status: OrderStatus.CANCELLED });
    await seed(world.a, { at: AT.end, paise: 500, pages: 1, status: OrderStatus.EXPIRED });
    const d = await data();
    expect(d.basis).toBe('ESTIMATED_ORDER_VALUE');
    expect(d.timezone).toBe('Asia/Kolkata');
    expect(d.totals).toEqual({
      orderCount: 4, countedOrders: 2, estimatedOrderValuePaise: 2000, averageEstimatedOrderValuePaise: 1000, pagesRequested: 13,
      ordersWithUnknownPages: 0, zeroValueOrders: 0, printStarted: 2, cancelled: 1, expired: 1, excludedQuotedValuePaise: 1499
    });
  });

  it('never presents collected revenue: payments are explicitly unavailable', async () => {
    await seed(world.a, { at: AT.start, paise: 100 });
    const d = await data();
    expect(d.collected).toEqual({ available: false, reason: 'NO_CUSTOMER_PAYMENT_RECORDS' });
    expect(JSON.stringify(d)).not.toMatch(/revenueCollected|netEarnings|refund/i);
  });

  it('uses Asia/Kolkata day boundaries: start inclusive, next day exclusive, and buckets the daily series by IST date', async () => {
    await seed(world.a, { at: AT.prevEnd, paise: 100 });
    await seed(world.a, { at: AT.start, paise: 200 });
    await seed(world.a, { at: AT.end, paise: 400 });
    await seed(world.a, { at: AT.next, paise: 800 });
    expect((await data()).totals.estimatedOrderValuePaise).toBe(600);
    const many = await data('?from=2026-03-09&to=2026-03-11');
    expect(many.daily.map((p: { date: string; estimatedOrderValuePaise: number }) => [p.date, p.estimatedOrderValuePaise])).toEqual([
      ['2026-03-09', 100], ['2026-03-10', 600], ['2026-03-11', 800]
    ]);
    expect(many.totals.estimatedOrderValuePaise).toBe(1500);
  });

  it('chart series, breakdowns and totals all agree and empty days are zero-filled', async () => {
    await seed(world.a, { at: AT.start, paise: 300, pages: 2, colour: 'colour', sides: 'duplex' });
    await seed(world.a, { at: AT.end, paise: 200, pages: 4, colour: 'bw' });
    const d = await data('?from=2026-03-09&to=2026-03-11');
    const sum = (xs: Array<{ estimatedOrderValuePaise: number }>) => xs.reduce((n, x) => n + x.estimatedOrderValuePaise, 0);
    expect(sum(d.daily)).toBe(d.totals.estimatedOrderValuePaise);
    expect(d.daily).toHaveLength(3);
    expect(d.daily[0]).toMatchObject({ orders: 0, estimatedOrderValuePaise: 0 });
    for (const k of ['colourMode', 'sides', 'paperSize']) {
      expect(d.breakdown[k].reduce((n: number, x: { valuePaise: number }) => n + x.valuePaise, 0)).toBe(500);
    }
    expect(d.breakdown.colourMode).toEqual([
      { key: 'colour', orders: 1, valuePaise: 300, pages: 2 },
      { key: 'bw', orders: 1, valuePaise: 200, pages: 4 }
    ]);
    expect(d.breakdown.status.find((s: { key: string }) => s.key === 'NEW')).toMatchObject({ orders: 2 });
    expect(d.breakdown.status).toHaveLength(Object.values(OrderStatus).length);
  });

  it('keeps big sums exact in integer paise', async () => {
    for (let i = 0; i < 3; i++) await seed(world.a, { at: AT.start, paise: 2_000_000_000 });
    await seed(world.a, { at: AT.start, paise: 1 });
    const d = await data();
    expect(d.totals.estimatedOrderValuePaise).toBe(6_000_000_001);
    expect(d.totals.averageEstimatedOrderValuePaise).toBe(1_500_000_000);
    expect(paiseToInr(6_000_000_001)).toBe('60000000.01');
    expect(paiseToInr(5)).toBe('0.05');
    expect(paiseToInr(0)).toBe('0.00');
  });

  it('reports missing page counts and zero-value orders honestly instead of guessing', async () => {
    await seed(world.a, { at: AT.start, paise: 0, pages: 3 });
    await seed(world.a, { at: AT.start, paise: 400, pages: null });
    const d = await data();
    expect(d.totals).toMatchObject({ countedOrders: 2, zeroValueOrders: 1, ordersWithUnknownPages: 1, pagesRequested: 3, estimatedOrderValuePaise: 400, averageEstimatedOrderValuePaise: 200 });
  });

  it('labels missing classification as unknown rather than inventing it', async () => {
    const o = await seed(world.a, { at: AT.start, paise: 100 });
    await prisma.order.update({ where: { id: o.id }, data: { printOptionsSnapshot: {} } });
    const d = await data();
    expect(d.breakdown.colourMode).toEqual([{ key: 'unknown', orders: 1, valuePaise: 100, pages: 2 }]);
  });

  it('does not re-price history when the rate card changes later', async () => {
    await seed(world.a, { at: AT.start, paise: 1000 });
    await prisma.pricingRule.updateMany({ where: { shopId: world.a.shopId }, data: { pricePerSheetPaise: 99_999 } });
    expect((await data()).totals.estimatedOrderValuePaise).toBe(1000);
  });

  it('is empty (not an error) for a range with no orders: null average, zeros', async () => {
    const d = await data();
    expect(d.totals).toMatchObject({ orderCount: 0, estimatedOrderValuePaise: 0, averageEstimatedOrderValuePaise: null });
    expect(d.comparison).toMatchObject({ available: false, reason: 'NO_PREVIOUS_ORDERS' });
  });

  it('compares to the equally long preceding window and gives percentages only from a real baseline', async () => {
    await seed(world.a, { at: '2026-03-01T06:00:00Z', paise: 1 }); // the shop already existed before the previous window
    await seed(world.a, { at: AT.start, paise: 1000 }); // 10 Mar (previous window 9-10 Mar)
    await seed(world.a, { at: AT.next, paise: 1500 }); // 11 Mar (current window 11-12 Mar)
    const d = await data('?from=2026-03-11&to=2026-03-12');
    expect(d.comparison.previousRange).toEqual({ from: '2026-03-09', to: '2026-03-10' });
    expect(d.comparison).toMatchObject({ available: true, reason: null });
    expect(d.comparison.previous.estimatedOrderValuePaise).toBe(1000);
    expect(d.comparison.changePct.estimatedOrderValue).toBe(50);
    expect(d.comparison.changePct.orderCount).toBe(0);
  });

  it("suppresses percentages when the previous window predates the shop's first order", async () => {
    await seed(world.a, { at: AT.start, paise: 1000 }); // first ever order sits inside the previous window
    await seed(world.a, { at: AT.next, paise: 1500 });
    const d = await data('?from=2026-03-11&to=2026-03-12');
    expect(d.comparison).toMatchObject({ available: false, reason: 'PREVIOUS_PERIOD_INCOMPLETE' });
    expect(d.comparison.changePct).toEqual({ estimatedOrderValue: null, orderCount: null, pagesRequested: null });
  });

  it('is tenant isolated: another shop is never visible and cannot be selected by parameter', async () => {
    await seed(world.a, { at: AT.start, paise: 1111 });
    await seed(world.b, { at: AT.start, paise: 2222 });
    expect((await data()).totals.estimatedOrderValuePaise).toBe(1111);
    expect((await rev(b)).json().data.totals.estimatedOrderValuePaise).toBe(2222);
    expect((await rev(a, `?shopId=${world.b.shopId}`)).statusCode).toBe(400);
    const csvA = await call(app, a, 'GET', `${REV}/export.csv?from=2026-03-10&to=2026-03-10`);
    expect(csvA.body).toContain('11.11');
    expect(csvA.body).not.toContain('22.22');
  });

  it('follows membership changes: a suspended shop is refused', async () => {
    await prisma.shop.update({ where: { id: world.a.shopId }, data: { status: 'SUSPENDED' } });
    expect((await rev(a)).statusCode).toBe(403);
  });

  it('validates dates strictly', async () => {
    for (const qs of ['?from=2026-02-30', '?from=yesterday', '?from=2026-03-10&to=2026-03-09', '?from=2026-01-01&to=2026-06-01', '?unknown=1', '?from=2026-3-1']) {
      const r = await rev(a, qs);
      expect(r.statusCode, qs).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
      expect((await call(app, a, 'GET', `${REV}/export.csv${qs}`)).statusCode, qs).toBe(400);
    }
    expect((await rev(a, '?from=2026-01-01&to=2026-04-03')).statusCode).toBe(200); // exactly 93 days
    expect((await rev(a, '')).json().data.range.days).toBe(1); // defaults to today
  });

  it('does not leak SQL, storage or customer details in responses', async () => {
    const o = await seed(world.a, { at: AT.start, paise: 100 });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: o.documentId } });
    const body = (await rev(a)).body + (await call(app, a, 'GET', `${REV}/export.csv?from=2026-03-10&to=2026-03-10`)).body;
    for (const forbidden of [doc.objectKey, 'objectKey', 'trackingToken', 'SELECT', 'originalFilename', 'http://', 'https://']) expect(body).not.toContain(forbidden);
  });

  describe('CSV export', () => {
    const csv = (s: Session = a, qs = '?from=2026-03-10&to=2026-03-10') => call(app, s, 'GET', `${REV}/export.csv${qs}`);

    it('returns a safe attachment whose counted rows add up to the dashboard figure', async () => {
      await seed(world.a, { at: AT.start, paise: 1250, pages: 5, copies: 2, started: true });
      await seed(world.a, { at: AT.end, paise: 750 });
      await seed(world.a, { at: AT.end, paise: 999, status: OrderStatus.CANCELLED });
      await seed(world.a, { at: AT.next, paise: 5 });
      const r = await csv();
      expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(r.headers['content-disposition']).toBe('attachment; filename="estimated-order-value-2026-03-10_to_2026-03-10.csv"');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-export-truncated']).toBe('false');
      expect(r.body.charCodeAt(0)).toBe(0xfeff);
      const lines = r.body.slice(1).trim().split('\r\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain('"Estimated order value (INR)"');
      expect(lines[0]).not.toMatch(/collected|paid|revenue/i);
      const cells = lines.slice(1).map((l) => l.slice(1, -1).split('","'));
      const counted = cells.filter((c) => c[10] === 'Yes').reduce((n, c) => n + Math.round(Number(c[11]) * 100), 0);
      expect(counted).toBe((await data()).totals.estimatedOrderValuePaise);
      expect(cells.find((c) => c[11] === '12.50')?.[5]).toBe('10'); // 5 pages x 2 copies
    });

    it('is formula-safe for the only free text it can contain', async () => {
      const o = await seed(world.a, { at: AT.start, paise: 100 });
      await prisma.order.update({ where: { id: o.id }, data: { orderNumber: '=HYPERLINK("x")' } });
      expect((await csv()).body).toContain(`"'=HYPERLINK(""x"")"`);
    });

    it('audits the export without data and is rate limited', async () => {
      await seed(world.a, { at: AT.start, paise: 100 });
      await csv();
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'revenue.export' } });
      expect(log.shopId).toBe(world.a.shopId);
      expect(log.metadata).toMatchObject({ from: '2026-03-10', to: '2026-03-10', rows: 1, truncated: false });
      const limited = buildApp({ RATE_LIMIT_SHOP_EXPORT_MAX: '2' });
      await limited.app.ready();
      try {
        const s = await login(limited.app, world.a.ownerEmail);
        const codes: number[] = [];
        for (let i = 0; i < 3; i++) codes.push((await call(limited.app, s, 'GET', `${REV}/export.csv?from=2026-03-10&to=2026-03-10`)).statusCode);
        expect(codes).toEqual([200, 200, 429]);
        expect((await call(limited.app, s, 'GET', `${REV}?from=2026-03-10&to=2026-03-10`)).statusCode).toBe(200);
      } finally {
        await limited.app.close();
      }
    });

    it('batches past 500 rows and flags truncation at the 5000-row cap while the dashboard still counts everything', async () => {
      await prisma.$executeRaw`
        INSERT INTO "Document" ("id","shopId","objectKey","originalFilename","status","updatedAt")
        SELECT 'bd' || g, ${world.a.shopId}, 'bulk/' || g, 'x.pdf', 'AVAILABLE', now() FROM generate_series(1, 5100) g`;
      await prisma.$executeRaw`
        INSERT INTO "Order" ("id","shopId","documentId","orderNumber","trackingToken","status","totalPaise","priceSnapshot","printOptionsSnapshot","createdAt","updatedAt")
        SELECT 'bo' || g, ${world.a.shopId}, 'bd' || g, 'BULK-' || g, 'tok-' || g, 'NEW', 10, '{"selectedPageCount":1}'::jsonb, '{"copies":1}'::jsonb,
               ${new Date(AT.start)}::timestamp + (g || ' seconds')::interval, now()
        FROM generate_series(1, 5100) g`;
      const r = await csv();
      expect(r.headers['x-export-truncated']).toBe('true');
      const lines = r.body.slice(1).trim().split('\r\n');
      expect(lines).toHaveLength(5001);
      expect(new Set(lines.slice(1).map((l) => l.split(',')[1])).size).toBe(5000);
      const d = await data();
      expect(d.totals.orderCount).toBe(5100);
      expect(d.totals.estimatedOrderValuePaise).toBe(51_000);
    }, 60_000);
  });
});

describe('revenue helpers', () => {
  it('pctChange never divides by zero and rounds to one decimal', () => {
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(0, 0)).toBeNull();
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(1, 3)).toBe(-66.7);
    expect(pctChange(0, 100)).toBe(-100);
  });

  it('previousRange is the equally long window ending the day before', () => {
    expect(previousRange(resolveRevenueRange({ from: '2026-03-08', to: '2026-03-10' }))).toMatchObject({ fromYmd: '2026-03-05', toYmd: '2026-03-07' });
    expect(previousRange(resolveRevenueRange({ from: '2026-03-01', to: '2026-03-01' }))).toMatchObject({ fromYmd: '2026-02-28', toYmd: '2026-02-28' });
  });
});
