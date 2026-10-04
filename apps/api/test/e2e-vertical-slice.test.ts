/**
 * E2E (API level): the full privacy-critical vertical slice against real PostgreSQL + local storage.
 *
 * Clock: PRINT_RETENTION_MINUTES only accepts whole minutes, so instead of waiting we freeze nothing and only
 * *advance* the process clock with `vi.setSystemTime` (Date only; timers/sockets stay real). The print confirmation
 * itself is a real API call at "real" time; later access checks / the cleanup job then run at now + 31 minutes.
 * Postgres stores the timestamps the app wrote, so no row is hand-edited except where noted.
 */
import { mkdtempSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { cleanupExpiredDocuments } from '../src/cleanup.js';
import { createStorage } from '../src/storage/index.js';
import { call, login, seedWorld, testConfig, type Session, type World } from './api-helpers.js';
import { testPrisma } from './helpers/db.js';

const prisma = testPrisma();
const dir = mkdtempSync(path.join(tmpdir(), 'printout-e2e-'));
const config = testConfig({ LOCAL_UPLOAD_DIR: dir, STORAGE_DRIVER: 'local' });
const storage = createStorage(config);
const { app } = createApp({ config, prisma, storage });

let base = '';
let world: World;
let a: Session;
let b: Session;

const RET_MS = config.PRINT_RETENTION_MINUTES * 60_000;

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  world = await seedWorld(prisma);
  a = await login(app, world.a.ownerEmail);
  b = await login(app, world.b.ownerEmail);
});
afterEach(() => vi.useRealTimers());

interface Sse {
  events: { event: string; data: any }[];
  stop(): void;
}
async function openSse(session: Session): Promise<Sse> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/v1/shop/events`, { headers: { cookie: session.cookie }, signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const out: Sse['events'] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event: (.+)/.exec(block)?.[1];
          const data = /data: (.+)/.exec(block)?.[1];
          if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { events: out, stop: () => ctrl.abort() };
}
const waitFor = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function makeThreePagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([595.28, 841.89]).drawText(`E2E page ${i + 1}`, { x: 50, y: 700 });
  return Buffer.from(await doc.save());
}

async function upload(slug: string, bytes: Buffer, fileName = 'thesis.pdf', mime = 'application/pdf') {
  const init = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${slug}/uploads/initiate`, payload: { fileName, byteSize: bytes.length, declaredMimeType: mime } });
  expect(init.statusCode).toBe(200);
  const { uploadId, uploadUrl } = init.json().data;
  const put = await fetch(new URL(uploadUrl, base), { method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': mime } });
  expect(put.status).toBe(200);
  const done = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${slug}/uploads/${uploadId}/complete` });
  expect(done.statusCode).toBe(200);
  return done.json().data as { documentId: string; pageCount: number; expiresAt: string; uploadedAt: string };
}

const options = (over: Record<string, unknown> = {}) => ({
  paperSize: 'A4',
  colourMode: 'colour',
  sides: 'duplex',
  copies: 2,
  pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 2 }] },
  ...over
});
const track = async (token: string) => (await app.inject({ method: 'GET', url: `/api/v1/public/orders/${token}` })).json().data;
const transition = (s: Session, id: string, toStatus: string) => call(app, s, 'POST', `/shop/orders/${id}/transitions`, { toStatus, clientRequestId: randomUUID() });
const confirm = (s: Session, id: string, clientRequestId = randomUUID()) => call(app, s, 'POST', `/shop/orders/${id}/print-confirmation`, { clientRequestId });
const access = (s: Session, id: string) => call(app, s, 'POST', `/shop/orders/${id}/document-access`, {});

async function placeFor(slug: string, bytes?: Buffer) {
  const doc = await upload(slug, bytes ?? (await makeThreePagePdf()));
  const q = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${slug}/quotes`, payload: { documentId: doc.documentId, printOptions: options() } });
  expect(q.statusCode).toBe(200);
  const o = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${slug}/orders`, payload: { quoteId: q.json().data.quoteId, clientRequestId: randomUUID(), customerDisplayNameOrReference: 'Asha' } });
  expect(o.statusCode).toBe(200);
  const orderId = (await prisma.order.findFirstOrThrow({ where: { trackingToken: o.json().data.trackingToken } })).id;
  return { doc, quote: q.json().data, order: o.json().data, orderId };
}

describe('vertical slice: upload -> print -> 30 min privacy deletion', () => {
  it('runs the whole lifecycle with tenant isolation, SSE scoping and exact retention', async () => {
    const pdf = await makeThreePagePdf();
    const sseA = await openSse(a);
    const sseB = await openSse(b);

    // upload (3 pages, server-counted)
    const doc = await upload(world.a.slug, pdf);
    expect(doc.pageCount).toBe(3);
    const dbDoc = await prisma.document.findUniqueOrThrow({ where: { id: doc.documentId } });
    expect(await storage.exists(dbDoc.objectKey)).toBe(true);
    expect(dbDoc.expiresAt!.getTime() - new Date(doc.uploadedAt).getTime()).toBe(24 * 3600e3);

    // quote: colour duplex 200? pages 1-2 -> 2 pages -> ceil(2/2)=1 sheet/copy x 2 copies = 2 sheets x 900 = 1800
    const q = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/quotes`, payload: { documentId: doc.documentId, printOptions: options() } });
    expect(q.statusCode).toBe(200);
    expect(q.json().data).toMatchObject({ selectedPageCount: 2, sheetsPerCopy: 1, totalSheets: 2, unitPricePaise: 900, totalPaise: 1800, currency: 'INR' });
    // other shop's slug cannot use this document
    const cross = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.b.slug}/quotes`, payload: { documentId: doc.documentId, printOptions: options() } });
    expect(cross.statusCode).toBeGreaterThanOrEqual(400);

    // order -> SSE for A only
    const o = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${world.a.slug}/orders`, payload: { quoteId: q.json().data.quoteId, clientRequestId: randomUUID() } });
    expect(o.statusCode).toBe(200);
    const { trackingToken, totalPaise, orderNumber } = o.json().data;
    expect(totalPaise).toBe(1800);
    await waitFor(() => sseA.events.some((e) => e.event === 'order.created'));
    await new Promise((r) => setTimeout(r, 150));
    expect(sseB.events.filter((e) => e.event.startsWith('order.'))).toEqual([]);
    const orderId = sseA.events.find((e) => e.event === 'order.created')!.data.id as string;
    expect(sseA.events.find((e) => e.event === 'order.created')!.data.orderNumber).toBe(orderNumber);

    // queue shows it for A, not B
    const queueA = (await call(app, a, 'GET', '/shop/orders?active=1')).json().data.items;
    expect(queueA).toHaveLength(1);
    expect(queueA[0]).toMatchObject({ id: orderId, status: 'NEW', totalPaise: 1800, pageCount: 3, selectedPageCount: 2, colourMode: 'colour', sides: 'duplex', copies: 2, documentStatus: 'AVAILABLE', deleteAfter: null });
    expect((await call(app, b, 'GET', '/shop/orders')).json().data.items).toHaveLength(0);

    // tenant isolation: B cannot see/act on anything of A
    expect((await call(app, b, 'GET', `/shop/orders/${orderId}`)).statusCode).toBe(404);
    expect((await transition(b, orderId, 'ACCEPTED')).statusCode).toBe(404);
    expect((await access(b, orderId)).statusCode).toBe(404);
    expect((await confirm(b, orderId)).statusCode).toBe(404);
    const analyticsB = (await call(app, b, 'GET', '/shop/analytics')).json().data;
    expect(analyticsB.orderCount).toBe(0);

    // accept -> printing
    expect((await transition(a, orderId, 'ACCEPTED')).statusCode).toBe(200);
    expect((await transition(a, orderId, 'PRINTING')).statusCode).toBe(200);
    expect((await track(trackingToken)).status).toBe('PRINTING');
    // PRINTED can't be forced via transitions
    expect((await transition(a, orderId, 'PRINTED')).statusCode).toBeGreaterThanOrEqual(400);

    // document access: signed URL, byte-identical PDF
    const acc = await access(a, orderId);
    expect(acc.statusCode).toBe(200);
    const accData = acc.json().data;
    expect(accData).toMatchObject({ contentDisposition: 'inline', mimeType: 'application/pdf' });
    const fetched = await fetch(new URL(accData.url, base));
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.compare(Buffer.from(await fetched.arrayBuffer()), pdf)).toBe(0);
    // tampered signature rejected
    expect((await fetch(new URL(accData.url.replace(/sig=[0-9a-f]/, 'sig=0'), base))).status).toBeGreaterThanOrEqual(400);
    // access never changes timestamps
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.documentId } })).printedAt).toBeNull();

    // print confirmation: real call
    const before = Date.now();
    const c1 = await confirm(a, orderId);
    const after = Date.now();
    expect(c1.statusCode).toBe(200);
    const printed = c1.json().data;
    const printedAt = new Date(printed.document.printedAt).getTime();
    expect(printedAt).toBeGreaterThanOrEqual(before - 5);
    expect(printedAt).toBeLessThanOrEqual(after + 5);
    expect(new Date(printed.document.deleteAfter).getTime()).toBe(printedAt + RET_MS);
    expect(printed.document.status).toBe('PRINTED_RETENTION');

    // duplicate confirmation (new clientRequestId, later time) is unchanged
    await new Promise((r) => setTimeout(r, 30));
    const c2 = await confirm(a, orderId);
    expect(c2.statusCode).toBe(200);
    expect(c2.json().data.document).toEqual(printed.document);

    // reprint access before expiry does not change deleteAfter
    expect((await access(a, orderId)).statusCode).toBe(200);
    const det1 = (await call(app, a, 'GET', `/shop/orders/${orderId}`)).json().data;
    expect(new Date(det1.document.deleteAfter).getTime()).toBe(printedAt + RET_MS);
    const pub1 = await track(trackingToken);
    expect(pub1.status).toBe('PRINTED');
    expect(pub1.document.status).toBe('PRINTED_RETENTION');
    expect(new Date(pub1.document.deleteAfter).getTime()).toBe(printedAt + RET_MS);
    expect(pub1.documentDeleteAfter).toBe(pub1.document.deleteAfter);
    await waitFor(() => sseA.events.some((e) => e.event === 'document.deletionScheduled'));

    // a still-valid signed URL, taken now, is also dead after the deadline
    const urlBefore = (await access(a, orderId)).json().data.url as string;

    // ---- time passes beyond deleteAfter (31 min), worker has NOT run ----
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(printedAt + RET_MS + 60_000) });
    const denied = await access(a, orderId);
    expect(denied.statusCode).toBe(410);
    expect(denied.json().error.code).toBe('DOCUMENT_UNAVAILABLE');
    expect((await fetch(new URL(urlBefore, base))).status).toBeGreaterThanOrEqual(400);
    // object still physically there because worker has not run
    expect(await storage.exists(dbDoc.objectKey)).toBe(true);
    expect((await confirm(a, orderId)).statusCode).toBe(200); // idempotent replay still fine
    expect(new Date((await call(app, a, 'GET', `/shop/orders/${orderId}`)).json().data.document.deleteAfter).getTime()).toBe(printedAt + RET_MS);

    // cleanup worker run
    const result = await cleanupExpiredDocuments(prisma, storage, { now: new Date() });
    expect(result).toMatchObject({ deleted: 1, failed: 0 });
    expect(await storage.exists(dbDoc.objectKey)).toBe(false);
    const files = existsSync(dir) ? JSON.stringify(readdirDeep(dir)) : '';
    expect(files).not.toContain(dbDoc.objectKey);
    const after1 = await prisma.document.findUniqueOrThrow({ where: { id: doc.documentId } });
    expect(after1.status).toBe('DELETED');
    expect(after1.deletedAt).not.toBeNull();
    expect(await prisma.order.count({ where: { id: orderId } })).toBe(1);
    expect((await access(a, orderId)).statusCode).toBe(410);
    expect((await fetch(new URL(urlBefore, base))).status).toBeGreaterThanOrEqual(400);
    // cleanup is idempotent
    expect(await cleanupExpiredDocuments(prisma, storage, { now: new Date() })).toMatchObject({ scanned: 0 });

    // order progresses after deletion
    expect((await transition(a, orderId, 'READY')).statusCode).toBe(200);
    expect((await track(trackingToken)).status).toBe('READY');
    expect((await transition(a, orderId, 'COLLECTED')).statusCode).toBe(200);
    const pub2 = await track(trackingToken);
    expect(pub2.status).toBe('COLLECTED');
    expect(pub2.document.status).toBe('DELETED');
    expect(pub2.document.deletedAt).toBeTruthy();
    expect(JSON.stringify(pub2)).not.toMatch(/objectKey|internal\/documents|sig=/);
    expect(pub2.timeline.map((t: { status: string }) => t.status)).toEqual(['NEW', 'ACCEPTED', 'PRINTING', 'PRINTED', 'READY', 'COLLECTED']);
    const det = (await call(app, a, 'GET', `/shop/orders/${orderId}`)).json().data;
    expect(det.document).toMatchObject({ status: 'DELETED', deletionState: 'DELETED' });
    expect(det.statusHistory).toHaveLength(6);

    // B still sees nothing
    expect((await call(app, b, 'GET', '/shop/orders')).json().data.items).toHaveLength(0);
    expect(sseB.events.filter((e) => e.event.startsWith('order.') || e.event.startsWith('document.'))).toEqual([]);
    sseA.stop();
    sseB.stop();
  });

  it('cancelled order path: cancel from NEW, tracking shows it, no confirmation / access possible', async () => {
    const { orderId, order } = await placeFor(world.a.slug);
    expect((await transition(a, orderId, 'CANCELLED')).statusCode).toBe(200);
    expect((await track(order.trackingToken)).status).toBe('CANCELLED');
    expect((await access(a, orderId)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await confirm(a, orderId)).statusCode).toBe(409);
    expect((await transition(a, orderId, 'ACCEPTED')).statusCode).toBe(409);
  });

  it('unprinted documents expire exactly 24h after upload completion via the worker; order becomes EXPIRED', async () => {
    const { orderId, order, doc } = await placeFor(world.a.slug);
    await transition(a, orderId, 'ACCEPTED');
    const row = await prisma.document.findUniqueOrThrow({ where: { id: doc.documentId } });
    // just before 24h: untouched
    let r = await cleanupExpiredDocuments(prisma, storage, { now: new Date(row.expiresAt!.getTime() - 1000) });
    expect(r.scanned).toBe(0);
    expect(await storage.exists(row.objectKey)).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(row.expiresAt!.getTime() + 1000) });
    expect((await access(a, orderId)).statusCode).toBe(410);
    r = await cleanupExpiredDocuments(prisma, storage, { now: new Date() });
    expect(r).toMatchObject({ deleted: 1, ordersExpired: 1 });
    expect(await storage.exists(row.objectKey)).toBe(false);
    const pub = await track(order.trackingToken);
    expect(pub.status).toBe('EXPIRED');
    expect(pub.document.status).toBe('DELETED');
  });

  it('orphan upload (never ordered) is removed by the same job', async () => {
    const doc = await upload(world.a.slug, await makeThreePagePdf());
    const row = await prisma.document.findUniqueOrThrow({ where: { id: doc.documentId } });
    const r = await cleanupExpiredDocuments(prisma, storage, { now: new Date(row.expiresAt!.getTime() + 1000) });
    expect(r.deleted).toBe(1);
    expect(await storage.exists(row.objectKey)).toBe(false);
  });
});

function readdirDeep(p: string): string[] {
  return readdirSync(p).flatMap((f) => {
    const full = path.join(p, f);
    return statSync(full).isDirectory() ? readdirDeep(full) : [full];
  });
}
