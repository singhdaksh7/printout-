import { DocumentStatus, OrderStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { csvCell, csvRow, CSV_HEADER, type HistoryItem } from '../src/domain/order-history.js';
import { istDayStartFromYmd, istYmd } from '../src/domain/time.js';
import { buildApp, call, login, newOrder, seedWorld, type Session, type World } from './api-helpers.js';

/** Fixed IST day used for boundary tests: 2026-03-10 IST = 2026-03-09T18:30:00Z .. 2026-03-10T18:30:00Z (exclusive). */
const AT = {
  dayBeforeLast: '2026-03-09T18:29:59.999Z', // 09 Mar 23:59:59.999 IST
  dayStart: '2026-03-09T18:30:00.000Z', // 10 Mar 00:00:00 IST
  dayEnd: '2026-03-10T18:29:59.999Z', // 10 Mar 23:59:59.999 IST
  nextDayStart: '2026-03-10T18:30:00.000Z' // 11 Mar 00:00:00 IST
};
const ADMIN_PATHS = ['/shop/orders/history', '/shop/orders/history/summary', '/shop/orders/history/export.csv'];

describe('order history API', () => {
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

  /** Real order pipeline (valid snapshots), then pin the file name, status and creation time. */
  async function seed(shop: { shopId: string; slug: string }, createdAt: string, filename = 'notes.pdf', status: OrderStatus = OrderStatus.NEW) {
    const o = await newOrder(app, prisma, shop);
    await prisma.document.update({ where: { id: o.doc.id }, data: { originalFilename: filename } });
    await prisma.order.update({ where: { id: o.order.id }, data: { createdAt: new Date(createdAt), status } });
    return o.order;
  }
  const day = '?from=2026-03-10&to=2026-03-10';
  const list = (s: Session | null, qs = day) => call(app, s, 'GET', `/shop/orders/history${qs}`);
  const fileNames = (res: { json: () => { data: { items: Array<{ originalFilename: string }> } } }) => res.json().data.items.map((i) => i.originalFilename);

  it('requires authentication and the shop-owner role on all three routes', async () => {
    for (const path of ADMIN_PATHS) expect((await call(app, null, 'GET', path)).statusCode).toBe(401);
    const admin = await login(app, world.adminEmail);
    for (const path of ADMIN_PATHS) expect((await call(app, admin, 'GET', path)).statusCode).toBe(403);
  });

  it('uses Asia/Kolkata day boundaries: start inclusive, next-day start exclusive, to-date inclusive', async () => {
    await seed(world.a, AT.dayBeforeLast, 'before.pdf');
    await seed(world.a, AT.dayStart, 'start.pdf');
    await seed(world.a, AT.dayEnd, 'end.pdf');
    await seed(world.a, AT.nextDayStart, 'after.pdf');
    expect(fileNames(await list(a))).toEqual(['end.pdf', 'start.pdf']); // newest first
    expect(fileNames(await list(a, '?from=2026-03-09&to=2026-03-11'))).toHaveLength(4);
    expect(fileNames(await list(a, '?to=2026-03-10'))).toHaveLength(2); // one date alone = that single day
    expect((await list(a)).json().data.range).toEqual({ from: '2026-03-10', to: '2026-03-10', timezone: 'Asia/Kolkata' });
  });

  it('defaults to today (IST) when no dates are given', async () => {
    await seed(world.a, new Date().toISOString(), 'now.pdf');
    await seed(world.a, new Date(Date.now() - 3 * 86_400e3).toISOString(), 'old.pdf');
    const r = await list(a, '');
    expect(fileNames(r)).toEqual(['now.pdf']);
    expect(r.json().data.range.from).toBe(istYmd());
  });

  it('helpers: IST day start and rejecting impossible dates', () => {
    expect(istDayStartFromYmd('2026-03-10')?.toISOString()).toBe(AT.dayStart);
    expect(istDayStartFromYmd('2026-02-30')).toBeUndefined();
    expect(istDayStartFromYmd('2026-13-01')).toBeUndefined();
    expect(istDayStartFromYmd('10-03-2026')).toBeUndefined();
    expect(istYmd(new Date(AT.dayBeforeLast))).toBe('2026-03-09');
    expect(istYmd(new Date(AT.dayStart))).toBe('2026-03-10');
  });

  it('validates parameters strictly', async () => {
    const bad = [
      '?from=2026-02-30', '?from=yesterday', '?from=2026-03-10&to=2026-03-09', '?from=2026-01-01&to=2026-06-01',
      '?status=BOGUS', '?limit=0', '?limit=101', '?unknown=1', '?cursor=%25%25%25', `?q=${'x'.repeat(101)}`
    ];
    for (const qs of bad) {
      const r = await list(a, qs);
      expect(r.statusCode, qs).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
    }
    for (const path of ['summary', 'export.csv']) {
      expect((await call(app, a, 'GET', `/shop/orders/history/${path}?from=2026-02-30`)).statusCode).toBe(400);
      expect((await call(app, a, 'GET', `/shop/orders/history/${path}?limit=5`)).statusCode).toBe(400);
    }
    // exactly 93 days is allowed
    expect((await list(a, '?from=2026-01-01&to=2026-04-03')).statusCode).toBe(200);
  });

  it('paginates with a stable cursor, including identical timestamps, without gaps or duplicates', async () => {
    for (let i = 0; i < 5; i++) await seed(world.a, i < 3 ? AT.dayEnd : AT.dayStart, `f${i}.pdf`);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = (await list(a, `${day}&limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json().data;
      seen.push(...r.items.map((i: { id: string }) => i.id));
      cursor = r.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('filters by one or several statuses', async () => {
    await seed(world.a, AT.dayEnd, 'a.pdf', OrderStatus.CANCELLED);
    await seed(world.a, AT.dayEnd, 'b.pdf', OrderStatus.EXPIRED);
    await seed(world.a, AT.dayEnd, 'c.pdf', OrderStatus.NEW);
    expect(fileNames(await list(a, `${day}&status=CANCELLED`))).toHaveLength(1);
    expect(fileNames(await list(a, `${day}&status=CANCELLED,EXPIRED`))).toHaveLength(2);
  });

  it('searches job code and file name case-insensitively, treats wildcards literally and never crosses tenants', async () => {
    const o1 = await seed(world.a, AT.dayEnd, 'Marksheet_2026.pdf');
    await seed(world.a, AT.dayEnd, '100%_done.pdf');
    await seed(world.a, AT.dayEnd, 'other.pdf');
    await seed(world.b, AT.dayEnd, 'Marksheet_2026.pdf');
    const names = async (q: string) => fileNames(await list(a, `${day}&q=${encodeURIComponent(q)}`));
    expect(await names('marksheet')).toEqual(['Marksheet_2026.pdf']);
    expect(await names('MARKSHEET_2026')).toEqual(['Marksheet_2026.pdf']);
    expect(await names(o1.orderNumber.toLowerCase())).toEqual(['Marksheet_2026.pdf']);
    expect(await names('%')).toEqual(['100%_done.pdf']);
    expect(await names('_')).toEqual(['100%_done.pdf', 'Marksheet_2026.pdf']);
    expect(await names('\\')).toEqual([]);
    expect(await names('zzz')).toEqual([]);
    expect(await names("'; DROP TABLE \"Order\"; --")).toEqual([]);
    // B only ever sees B's order, even when searching with A's order number
    const bSearch = (await list(b, `${day}&q=${encodeURIComponent(o1.orderNumber)}`)).json().data.items;
    expect(bSearch).toEqual([]);
  });

  it('is tenant isolated for list, cursor, summary and export', async () => {
    await seed(world.a, AT.dayEnd, 'secret-a.pdf');
    await seed(world.a, AT.dayEnd, 'secret-a2.pdf');
    await seed(world.b, AT.dayEnd, 'b-only.pdf');
    expect(fileNames(await list(b))).toEqual(['b-only.pdf']);
    const aPage = (await list(a, `${day}&limit=1`)).json().data;
    expect(aPage.nextCursor).toBeTruthy();
    const crossCursor = await list(b, `${day}&limit=5&cursor=${aPage.nextCursor}`);
    expect(crossCursor.body).not.toContain('secret-a');
    expect((await call(app, b, 'GET', `/shop/orders/history/summary${day}`)).json().data.total).toBe(1);
    const csvB = await call(app, b, 'GET', `/shop/orders/history/export.csv${day}`);
    expect(csvB.body).toContain('b-only.pdf');
    expect(csvB.body).not.toContain('secret-a');
  });

  it('summary counts by status, print initiated and deleted files for the range and search, ignoring the status filter', async () => {
    const o1 = await seed(world.a, AT.dayEnd, 'p1.pdf', OrderStatus.PRINTING);
    await seed(world.a, AT.dayStart, 'c1.pdf', OrderStatus.CANCELLED);
    await seed(world.a, AT.dayStart, 'e1.pdf', OrderStatus.EXPIRED);
    await seed(world.a, AT.nextDayStart, 'outside.pdf', OrderStatus.NEW);
    await prisma.document.update({
      where: { id: o1.documentId },
      data: { printInitiatedAt: new Date(AT.dayEnd), status: DocumentStatus.DELETED, deletedAt: new Date(AT.dayEnd) }
    });
    const s = (await call(app, a, 'GET', `/shop/orders/history/summary${day}&status=CANCELLED`)).json().data;
    expect(s).toMatchObject({ timezone: 'Asia/Kolkata', total: 3, printInitiated: 1, filesDeleted: 1 });
    expect(s.byStatus).toMatchObject({ PRINTING: 1, CANCELLED: 1, EXPIRED: 1, NEW: 0 });
    const searched = (await call(app, a, 'GET', `/shop/orders/history/summary${day}&q=e1`)).json().data;
    expect(searched.total).toBe(1);
  });

  it('returns metadata only: a fixed field set, no storage keys or links, and a deleted file shows its deletion time', async () => {
    const o = await seed(world.a, AT.dayEnd, 'gone.pdf', OrderStatus.PRINTING);
    await prisma.document.update({
      where: { id: o.documentId },
      data: { status: DocumentStatus.DELETED, deletedAt: new Date(AT.dayEnd), printInitiatedAt: new Date(AT.dayStart) }
    });
    const res = await list(a);
    const item = res.json().data.items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        'colourMode', 'copies', 'createdAt', 'documentStatus', 'fileDeletedAt', 'handledBy', 'id', 'originalFilename', 'orderNumber',
        'pageCount', 'paperSize', 'printInitiatedAt', 'selectedPageCount', 'sides', 'status', 'totalPaise'
      ].sort()
    );
    expect(item).toMatchObject({ documentStatus: 'DELETED', fileDeletedAt: AT.dayEnd, printInitiatedAt: AT.dayStart });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: o.documentId } });
    for (const forbidden of [doc.objectKey, 'objectKey', 'http://', 'https://', 'trackingToken', '"url"']) expect(res.body).not.toContain(forbidden);
  });

  it('labels who made the latest change: owner name, or Automatic for expiry; never an invented printed state', async () => {
    const o = await seed(world.a, AT.dayEnd, 'x.pdf');
    const cancel = await call(app, a, 'POST', `/shop/orders/${o.id}/transitions`, { toStatus: 'CANCELLED', clientRequestId: randomUUID() });
    expect(cancel.statusCode).toBe(200);
    const e = await seed(world.a, AT.dayStart, 'exp.pdf', OrderStatus.EXPIRED);
    await prisma.orderStatusHistory.create({ data: { orderId: e.id, fromStatus: OrderStatus.NEW, toStatus: OrderStatus.EXPIRED } });
    const items = (await list(a, '?from=2026-03-10&to=2026-03-10')).json().data.items as Array<{ originalFilename: string; handledBy: string | null; status: string }>;
    expect(items.find((i) => i.originalFilename === 'exp.pdf')).toMatchObject({ handledBy: 'Automatic', status: 'EXPIRED' });
    const cancelled = (await call(app, a, 'GET', `/shop/orders/history?status=CANCELLED&from=2026-03-10&to=2026-03-10`)).json().data.items;
    // the transition's updatedAt does not move createdAt, so the order stays inside the pinned day
    expect(cancelled[0]).toMatchObject({ handledBy: 'Sharma Print Owner', status: 'CANCELLED' });
    expect(items.some((i) => i.status === 'PRINTED')).toBe(false);
  });

  describe('CSV export', () => {
    it('returns an attachment with safe headers, a BOM, one header row and the filtered rows only', async () => {
      await seed(world.a, AT.dayEnd, 'one.pdf');
      await seed(world.a, AT.nextDayStart, 'outside.pdf');
      const r = await call(app, a, 'GET', `/shop/orders/history/export.csv${day}`);
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(r.headers['content-disposition']).toBe('attachment; filename="order-history-2026-03-10_to_2026-03-10.csv"');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-export-truncated']).toBe('false');
      expect(r.body.charCodeAt(0)).toBe(0xfeff);
      const lines = r.body.slice(1).trim().split('\r\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(CSV_HEADER.map((h) => `"${h}"`).join(','));
      expect(lines[1]).toContain('"one.pdf"');
      expect(r.body).not.toContain('outside.pdf');
    });

    it('neutralises spreadsheet formulas and escapes quotes, commas and newlines in file names', async () => {
      await seed(world.a, AT.dayEnd, '=HYPERLINK("http://evil","x").pdf');
      await seed(world.a, AT.dayEnd, '+SUM(1,1).pdf');
      await seed(world.a, AT.dayEnd, '@cmd|calc.pdf');
      await seed(world.a, AT.dayEnd, '-2+3.pdf');
      await seed(world.a, AT.dayEnd, 'say "hi", ok.pdf');
      const body = (await call(app, a, 'GET', `/shop/orders/history/export.csv${day}`)).body;
      expect(body).toContain(`"'=HYPERLINK(""http://evil"",""x"").pdf"`);
      expect(body).toContain(`"'+SUM(1,1).pdf"`);
      expect(body).toContain(`"'@cmd|calc.pdf"`);
      expect(body).toContain(`"'-2+3.pdf"`);
      expect(body).toContain(`"say ""hi"", ok.pdf"`);
    });

    it('applies status and search filters, writes an audit entry without file names, and is rate limited per session', async () => {
      await seed(world.a, AT.dayEnd, 'keep.pdf', OrderStatus.CANCELLED);
      await seed(world.a, AT.dayEnd, 'drop.pdf', OrderStatus.NEW);
      const r = await call(app, a, 'GET', `/shop/orders/history/export.csv${day}&status=CANCELLED&q=keep`);
      expect(r.body).toContain('keep.pdf');
      expect(r.body).not.toContain('drop.pdf');
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.history_export' } });
      expect(log.shopId).toBe(world.a.shopId);
      expect(log.metadata).toMatchObject({ from: '2026-03-10', to: '2026-03-10', rows: 1, truncated: false, hasSearch: true, hasStatus: true });
      expect(JSON.stringify(log.metadata)).not.toContain('keep');
    });

    it('returns 429 RATE_LIMITED with Retry-After once the export budget is spent, leaving reads unaffected', async () => {
      const limited = buildApp({ RATE_LIMIT_SHOP_EXPORT_MAX: '2' });
      await limited.app.ready();
      try {
        const s = await login(limited.app, world.a.ownerEmail);
        const codes: number[] = [];
        for (let i = 0; i < 3; i++) codes.push((await call(limited.app, s, 'GET', `/shop/orders/history/export.csv${day}`)).statusCode);
        expect(codes).toEqual([200, 200, 429]);
        const blocked = await call(limited.app, s, 'GET', `/shop/orders/history/export.csv${day}`);
        expect(blocked.json().error.code).toBe('RATE_LIMITED');
        expect(blocked.headers['retry-after']).toBeTruthy();
        expect((await call(limited.app, s, 'GET', `/shop/orders/history${day}`)).statusCode).toBe(200);
      } finally {
        await limited.app.close();
      }
    });
  });

  it('keeps existing consumers working: /shop/orders and /shop/orders/:id are unchanged', async () => {
    const o = await seed(world.a, AT.dayEnd, 'compat.pdf');
    const q = await call(app, a, 'GET', '/shop/orders');
    expect(q.statusCode).toBe(200);
    expect(q.json().data.items[0]).toHaveProperty('deleteAfter');
    expect((await call(app, a, 'GET', `/shop/orders/${o.id}`)).statusCode).toBe(200);
    expect((await call(app, a, 'GET', '/shop/orders/history-not-an-id')).statusCode).toBe(404);
  });
});

describe('csv helpers', () => {
  it('csvCell quotes everything and prefixes formula starters (including after whitespace, tab and CR)', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(12)).toBe('"12"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('l1\nl2\r\nl3')).toBe('"l1 l2 l3"');
    for (const s of ['=1+1', '+1', '-1', '@x', '\t=1', '\r=1', '  =1']) expect(csvCell(s)).toMatch(/^"'/);
    expect(csvCell('safe=1')).toBe('"safe=1"');
  });

  it('csvRow lists IST times and no customer data', () => {
    const item: HistoryItem = {
      id: 'i', orderNumber: 'X-1', status: OrderStatus.CANCELLED, createdAt: new Date(AT.dayStart), originalFilename: 'f.pdf', pageCount: 3,
      selectedPageCount: 2, copies: 2, colourMode: 'bw', sides: 'single', paperSize: 'A4', totalPaise: 1250, printInitiatedAt: null,
      documentStatus: DocumentStatus.DELETED, fileDeletedAt: new Date(AT.dayEnd), handledBy: 'Rakesh'
    };
    expect(csvRow(item)).toBe('"2026-03-10 00:00:00","X-1","f.pdf","3","2","2","bw","single","A4","CANCELLED","","2026-03-10 23:59:59","Rakesh","12.50"');
  });
});
