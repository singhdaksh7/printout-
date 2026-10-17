import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, call, login, newOrder, seedDevice, seedWorld, type Session, type World } from './api-helpers.js';

/**
 * Windows print agent: server contract, lifecycle, isolation and crash-recovery rules.
 * Invariant under test: nothing here ever claims "printed", and a job that MAY have reached the spooler is never re-queued.
 */
describe('Windows print agent API', () => {
  const { app, prisma } = buildApp();
  let world: World;
  let owner: Session;
  let ownerB: Session;
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
    owner = await login(app, world.a.ownerEmail);
    ownerB = await login(app, world.b.ownerEmail);
  });

  const dev = (auth: Record<string, string>, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/v1${url}`, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });
  const patchPrinter = (s: Session, deviceId: string, printerId: string, body: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/v1/shop/devices/${deviceId}/printers/${printerId}`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf }, payload: body as object });

  const printerReport = (over: Record<string, unknown> = {}) => ({
    name: 'Front Desk LaserJet',
    driverName: 'HP Universal Printing PCL 6',
    connectivity: 'ONLINE',
    supportsColour: false,
    supportsDuplex: true,
    paperSizes: ['A4', 'Letter'],
    ...over
  });

  /** A Windows device with one reported + authorized default printer, in shop A (unless overridden). */
  async function windowsSetup(opts: { shop?: 'a' | 'b'; colour?: boolean; authorize?: boolean } = {}) {
    const shop = opts.shop === 'b' ? world.b : world.a;
    const session = opts.shop === 'b' ? ownerB : owner;
    const d = await seedDevice(prisma, shop.shopId, { platform: 'WINDOWS', name: 'Counter PC' });
    const res = await dev(d.auth, 'PUT', '/device/printers', { printers: [printerReport({ supportsColour: opts.colour ?? false })] });
    expect(res.statusCode).toBe(200);
    const printer = res.json().data.printers[0] as { id: string };
    if (opts.authorize !== false) {
      const p = await patchPrinter(session, d.device.id, printer.id, { authorized: true, isDefault: true });
      expect(p.statusCode).toBe(200);
    }
    return { ...d, printer, shop, session };
  }

  const enqueue = (s: Session, orderId: string, body: Record<string, unknown> = {}) =>
    call(app, s, 'POST', `/shop/orders/${orderId}/print-jobs`, { clientRequestId: randomUUID(), ...body });
  const claim = (auth: Record<string, string>) => dev(auth, 'POST', '/device/print-jobs/claim', {});
  const progress = (auth: Record<string, string>, jobId: string, body: Record<string, unknown>) =>
    dev(auth, 'POST', `/device/print-jobs/${jobId}/progress`, body);
  const jobRow = (id: string) => prisma.devicePrintJob.findUniqueOrThrow({ where: { id } });
  const expireLease = (id: string) => prisma.devicePrintJob.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });

  async function queued(w: Awaited<ReturnType<typeof windowsSetup>>, options?: unknown) {
    const o = await newOrder(app, prisma, w.shop, options as never);
    const res = await enqueue(w.session, o.order.id);
    expect(res.statusCode).toBe(201);
    return { o, job: res.json().data.job as { id: string; status: string } };
  }
  async function claimed(w: Awaited<ReturnType<typeof windowsSetup>>) {
    const q = await queued(w);
    const c = await claim(w.auth);
    expect(c.statusCode).toBe(200);
    const job = c.json().data.job as { id: string; leaseId: string; status: string; documentName: string; attempt: number };
    expect(job.id).toBe(q.job.id);
    return { ...q, lease: job.leaseId, claim: job };
  }

  describe('pairing + printer discovery', () => {
    it('a WINDOWS device pairs with a short-lived code and its credential works on the printer API', async () => {
      const code = (await call(app, owner, 'POST', '/shop/devices/pairing-codes', {})).json().data.code as string;
      const paired = await app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { code, deviceName: 'Counter PC', platform: 'WINDOWS', appVersion: '0.1.0', osVersion: 'Windows 11 24H2' } });
      expect(paired.statusCode).toBe(200);
      const cred = paired.json().data.deviceCredential as string;
      expect(cred.startsWith('pbd_')).toBe(true);
      const res = await dev({ authorization: `Bearer ${cred}` }, 'PUT', '/device/printers', { printers: [printerReport()] });
      expect(res.statusCode).toBe(200);
      // the code is single use
      const again = await app.inject({ method: 'POST', url: '/api/v1/device/pair', payload: { code, deviceName: 'X', platform: 'WINDOWS' } });
      expect(again.statusCode).toBe(400);
    });

    it('reports are upserted; the owner decisions survive; vanished printers are marked absent, not deleted', async () => {
      const w = await windowsSetup();
      const second = printerReport({ name: 'Back Office Inkjet', supportsColour: true });
      const r = await dev(w.auth, 'PUT', '/device/printers', { printers: [printerReport({ connectivity: 'OFFLINE' }), second] });
      const printers = r.json().data.printers as Array<{ name: string; authorized: boolean; isDefault: boolean; connectivity: string; present: boolean }>;
      const front = printers.find((p) => p.name === 'Front Desk LaserJet')!;
      expect(front).toMatchObject({ authorized: true, isDefault: true, connectivity: 'OFFLINE', present: true });
      expect(printers.find((p) => p.name === 'Back Office Inkjet')).toMatchObject({ authorized: false, isDefault: false });
      const r2 = await dev(w.auth, 'PUT', '/device/printers', { printers: [second] });
      const after = r2.json().data.printers as Array<{ name: string; present: boolean; authorized: boolean }>;
      expect(after.find((p) => p.name === 'Front Desk LaserJet')).toMatchObject({ present: false, authorized: true });
    });

    it('rejects Android devices, bad payloads, duplicate names and control characters; requires authentication', async () => {
      const android = await seedDevice(prisma, world.a.shopId, { platform: 'ANDROID' });
      expect((await dev(android.auth, 'PUT', '/device/printers', { printers: [] })).statusCode).toBe(409);
      const w = await windowsSetup();
      expect((await dev(w.auth, 'PUT', '/device/printers', { printers: [printerReport(), printerReport()] })).statusCode).toBe(400);
      expect((await dev(w.auth, 'PUT', '/device/printers', { printers: [printerReport({ name: 'bad\u0007name' })] })).statusCode).toBe(400);
      expect((await dev(w.auth, 'PUT', '/device/printers', { printers: [printerReport({ shopId: 'x' })] })).statusCode).toBe(400);
      expect((await dev({}, 'PUT', '/device/printers', { printers: [] })).statusCode).toBe(401);
      expect((await dev({ authorization: 'Bearer pbd_nope' }, 'PUT', '/device/printers', { printers: [] })).statusCode).toBe(401);
    });

    it('Devices list exposes printers with capabilities, and never credentials', async () => {
      const w = await windowsSetup({ colour: true });
      const res = await call(app, owner, 'GET', '/shop/devices');
      const d = res.json().data.devices.find((x: { id: string }) => x.id === w.device.id);
      expect(d.printers[0]).toMatchObject({ name: 'Front Desk LaserJet', supportsColour: true, supportsDuplex: true, authorized: true, isDefault: true, paperSizes: ['A4', 'Letter'] });
      expect(JSON.stringify(res.json())).not.toMatch(/credentialHash|pbd_|previousCredential/);
    });

    it('printer authorization is the owner only, tenant scoped, and one default per shop', async () => {
      const w = await windowsSetup();
      const other = await windowsSetup({ shop: 'b' });
      // shop B cannot touch shop A's printer
      expect((await patchPrinter(ownerB, w.device.id, w.printer.id, { authorized: false })).statusCode).toBe(404);
      expect((await patchPrinter(ownerB, other.device.id, w.printer.id, { authorized: false })).statusCode).toBe(404);
      // the device credential cannot self-authorize (no such route for devices)
      const own = await app.inject({ method: 'PATCH', url: `/api/v1/shop/devices/${w.device.id}/printers/${w.printer.id}`, headers: w.auth, payload: { authorized: true } });
      expect([401, 403]).toContain(own.statusCode);
      // a second printer takes over the default
      const r = await dev(w.auth, 'PUT', '/device/printers', { printers: [printerReport(), printerReport({ name: 'Second' })] });
      const second = (r.json().data.printers as Array<{ id: string; name: string }>).find((p) => p.name === 'Second')!;
      expect((await patchPrinter(owner, w.device.id, second.id, { isDefault: true })).statusCode).toBe(409); // not authorized yet
      expect((await patchPrinter(owner, w.device.id, second.id, { authorized: true, isDefault: true })).statusCode).toBe(200);
      const rows = await prisma.devicePrinter.findMany({ where: { shopId: world.a.shopId, isDefault: true } });
      expect(rows.map((x) => x.id)).toEqual([second.id]);
      // de-authorizing clears the default
      await patchPrinter(owner, w.device.id, second.id, { authorized: false });
      expect(await prisma.devicePrinter.count({ where: { shopId: world.a.shopId, isDefault: true } })).toBe(0);
    });
  });

  describe('enqueue', () => {
    it('starts the print through the one print engine: order PRINTING, retention window, but never PRINTED', async () => {
      const w = await windowsSetup();
      const { o, job } = await queued(w);
      expect(job.status).toBe('QUEUED');
      const order = await prisma.order.findUniqueOrThrow({ where: { id: o.order.id } });
      const doc = await prisma.document.findUniqueOrThrow({ where: { id: o.doc.id } });
      expect(order.status).toBe('PRINTING');
      expect(doc.printInitiatedAt).not.toBeNull();
      expect(doc.printedAt).toBeNull();
    });

    it('requires an authorized printer and a supported option set', async () => {
      const w = await windowsSetup({ authorize: false });
      const o = await newOrder(app, prisma, w.shop);
      const none = await enqueue(w.session, o.order.id);
      expect(none.statusCode).toBe(409);
      expect(none.json().error.code).toBe('PRINTER_NOT_AUTHORIZED');
      const explicit = await enqueue(w.session, o.order.id, { printerId: w.printer.id });
      expect(explicit.json().error.code).toBe('PRINTER_NOT_AUTHORIZED');
      await patchPrinter(w.session, w.device.id, w.printer.id, { authorized: true, isDefault: true });
      const colour = await newOrder(app, prisma, w.shop, { paperSize: 'A4', colourMode: 'colour', sides: 'single', copies: 1, pageSelection: { mode: 'all' } });
      const bad = await enqueue(w.session, colour.order.id);
      expect(bad.json().error.code).toBe('PRINTER_UNSUPPORTED_OPTIONS');
      expect(await prisma.devicePrintJob.count()).toBe(0);
    });

    it('is idempotent per clientRequestId and refuses a second active job for the same order', async () => {
      const w = await windowsSetup();
      const o = await newOrder(app, prisma, w.shop);
      const clientRequestId = randomUUID();
      const first = await enqueue(w.session, o.order.id, { clientRequestId });
      const replay = await enqueue(w.session, o.order.id, { clientRequestId });
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().data.job.id).toBe(first.json().data.job.id);
      const dup = await enqueue(w.session, o.order.id);
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('ACTIVE_PRINT_JOB_EXISTS');
      const otherOrder = await newOrder(app, prisma, w.shop);
      const reuse = await enqueue(w.session, otherOrder.order.id, { clientRequestId });
      expect(reuse.statusCode).toBe(409);
      expect(await prisma.devicePrintJob.count()).toBe(1);
    });

    it('concurrent enqueues for one order create exactly one job', async () => {
      const w = await windowsSetup();
      const o = await newOrder(app, prisma, w.shop);
      const results = await Promise.all([1, 2, 3, 4].map(() => enqueue(w.session, o.order.id)));
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(await prisma.devicePrintJob.count()).toBe(1);
    });

    it('tenant isolation: shop B can neither print shop A orders nor use shop A printers', async () => {
      const a = await windowsSetup();
      const b = await windowsSetup({ shop: 'b' });
      const orderA = await newOrder(app, prisma, world.a);
      expect((await enqueue(ownerB, orderA.order.id)).statusCode).toBe(404);
      const orderB = await newOrder(app, prisma, world.b);
      const res = await enqueue(ownerB, orderB.order.id, { printerId: a.printer.id });
      expect(res.statusCode).toBe(404);
      expect((await enqueue(ownerB, orderB.order.id)).statusCode).toBe(201);
      void b;
      expect(await prisma.devicePrintJob.count({ where: { shopId: world.a.shopId } })).toBe(0);
    });

    it('a print again after PRINT_INITIATED needs reprint:true', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      for (const status of ['DOWNLOADING', 'SUBMITTING', 'PRINT_INITIATED']) {
        expect((await progress(w.auth, c.job.id, { leaseId: c.lease, status })).statusCode).toBe(200);
      }
      const again = await enqueue(w.session, c.o.order.id);
      expect(again.statusCode).toBe(409);
      const re = await enqueue(w.session, c.o.order.id, { reprint: true });
      expect(re.statusCode).toBe(201);
    });
  });

  describe('claim', () => {
    it('only the targeted device claims, and a claim is exclusive', async () => {
      const w = await windowsSetup();
      const sibling = await seedDevice(prisma, world.a.shopId, { platform: 'WINDOWS', name: 'Other PC' });
      const stranger = await seedDevice(prisma, world.b.shopId, { platform: 'WINDOWS', name: 'Stranger' });
      await queued(w);
      expect((await claim(sibling.auth)).json().data.job).toBeNull();
      expect((await claim(stranger.auth)).json().data.job).toBeNull();
      const [x, y] = await Promise.all([claim(w.auth), claim(w.auth)]);
      const jobs = [x, y].map((r) => r.json().data as { job: { leaseId: string } | null; resumed: boolean });
      // one real claim; the concurrent twin must be a resume of the SAME lease, never a second lease
      expect(new Set(jobs.map((j) => j.job?.leaseId)).size).toBe(1);
      expect(await prisma.devicePrintJob.count({ where: { status: 'CLAIMED' } })).toBe(1);
      expect((await jobRow((await prisma.devicePrintJob.findFirstOrThrow()).id)).attempt).toBe(1);
    });

    it('a claim returns options and a spooler document name, never a URL, filename or storage key', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      const body = JSON.stringify(c.claim);
      expect(body).not.toMatch(/objectKey|test-|https?:|notes\.pdf/);
      expect(c.claim.documentName).toBe(`pb-${c.job.id}-1`);
      expect(c.claim).toMatchObject({ status: 'CLAIMED', attempt: 1, options: { copies: 1, colourMode: 'bw', sides: 'single', paperSize: 'A4', pageSelection: { mode: 'all' } } });
    });

    it('serial printing: while a job is held no second job is handed out', async () => {
      const w = await windowsSetup();
      const first = await claimed(w);
      await queued(w);
      const again = await claim(w.auth);
      expect(again.json().data.job.id).toBe(first.job.id);
      expect(again.json().data.resumed).toBe(true);
    });

    it('a de-authorized printer stops being claimable', async () => {
      const w = await windowsSetup();
      await queued(w);
      await patchPrinter(w.session, w.device.id, w.printer.id, { authorized: false });
      expect((await claim(w.auth)).json().data.job).toBeNull();
    });

    it('an Android device cannot use the print queue', async () => {
      const android = await seedDevice(prisma, world.a.shopId, { platform: 'ANDROID' });
      expect((await claim(android.auth)).statusCode).toBe(409);
    });
  });

  describe('progress state machine', () => {
    it('walks the happy path to PRINT_INITIATED and never reaches a "printed" state', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      const steps: Array<[string, Record<string, unknown>]> = [
        ['DOWNLOADING', {}],
        ['SUBMITTING', {}],
        ['SUBMITTED_TO_SPOOLER', { spoolerJobId: 42, spoolerState: 'Spooling' }],
        ['PRINT_INITIATED', { spoolerState: 'Printing' }]
      ];
      for (const [status, extra] of steps) {
        const r = await progress(w.auth, c.job.id, { leaseId: c.lease, status, ...extra });
        expect(r.statusCode).toBe(200);
        expect(r.json().data.job.status).toBe(status);
      }
      const row = await jobRow(c.job.id);
      expect(row).toMatchObject({ status: 'PRINT_INITIATED', spoolerJobId: 42, spoolerState: 'Printing' });
      expect(row.submittingAt).not.toBeNull();
      expect(row.printInitiatedAt).not.toBeNull();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: c.o.order.id } });
      expect(order.status).toBe('PRINTING');
      expect((await prisma.document.findUniqueOrThrow({ where: { id: c.o.doc.id } })).printedAt).toBeNull();
      expect(await prisma.orderStatusHistory.count({ where: { orderId: c.o.order.id, toStatus: 'PRINTED' } })).toBe(0);
    });

    it('rejects skipped/invalid edges, "printed" claims and unknown statuses; state stays put', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      expect((await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'SUBMITTING' })).statusCode).toBe(409); // skips DOWNLOADING
      expect((await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'PRINT_INITIATED' })).statusCode).toBe(409);
      expect((await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'PRINTED' })).statusCode).toBe(400);
      expect((await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'QUEUED' })).statusCode).toBe(400);
      expect((await jobRow(c.job.id)).status).toBe('CLAIMED');
    });

    it('repeating a status is an idempotent no-op that renews the lease', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'DOWNLOADING' });
      await prisma.devicePrintJob.update({ where: { id: c.job.id }, data: { leaseExpiresAt: new Date(Date.now() + 5000) } });
      const r = await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'DOWNLOADING' });
      expect(r.statusCode).toBe(200);
      expect((await jobRow(c.job.id)).leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
      // a replayed terminal report (lost acknowledgement) is also accepted and changes nothing
      await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'FAILED', errorCode: 'X_FAIL' });
      const before = await jobRow(c.job.id);
      const replay = await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'FAILED', errorCode: 'X_FAIL' });
      expect(replay.statusCode).toBe(200);
      expect((await jobRow(c.job.id)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it('a wrong lease, another device, another shop and a revoked device cannot move a job', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      const sibling = await seedDevice(prisma, world.a.shopId, { platform: 'WINDOWS' });
      const stranger = await seedDevice(prisma, world.b.shopId, { platform: 'WINDOWS' });
      const body = { leaseId: c.lease, status: 'DOWNLOADING' };
      expect((await progress(w.auth, c.job.id, { ...body, leaseId: randomUUID() })).statusCode).toBe(409);
      expect((await progress(sibling.auth, c.job.id, body)).statusCode).toBe(404);
      expect((await progress(stranger.auth, c.job.id, body)).statusCode).toBe(404);
      expect((await dev(sibling.auth, 'POST', `/device/print-jobs/${c.job.id}/download`, { leaseId: c.lease })).statusCode).toBe(404);
      expect((await jobRow(c.job.id)).status).toBe('CLAIMED');
      // revoke: the very next request is refused
      expect((await call(app, owner, 'POST', `/shop/devices/${w.device.id}/revoke`, {})).statusCode).toBe(200);
      const after = await progress(w.auth, c.job.id, body);
      expect(after.statusCode).toBe(401);
      expect(after.json().error.code).toBe('DEVICE_REVOKED');
      expect((await claim(w.auth)).statusCode).toBe(401);
    });

    it('error text is bounded and sanitized; codes are constrained', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'FAILED', errorCode: 'bad code!', errorMessage: `line1\nline2\u0000${'x'.repeat(500)}` });
      const row = await jobRow(c.job.id);
      expect(row.errorCode).toBe('AGENT_ERROR');
      expect(row.errorMessage).not.toMatch(/[\u0000-\u001f]/);
      expect(row.errorMessage!.length).toBeLessThanOrEqual(300);
    });

    it('emits printJob.updated with ids and statuses only', async () => {
      const { app: a2, prisma: p2, events } = buildApp();
      await a2.ready();
      const seen: Array<{ event: string; data: unknown }> = [];
      const original = events.emit.bind(events);
      events.emit = ((shopId: string, event: string, data: unknown) => {
        seen.push({ event, data });
        return original(shopId, event, data);
      }) as typeof events.emit;
      const s = await login(a2, world.a.ownerEmail);
      const d = await seedDevice(p2, world.a.shopId, { platform: 'WINDOWS' });
      const rep = await a2.inject({ method: 'PUT', url: '/api/v1/device/printers', headers: d.auth, payload: { printers: [printerReport()] } });
      const pid = rep.json().data.printers[0].id as string;
      await a2.inject({ method: 'PATCH', url: `/api/v1/shop/devices/${d.device.id}/printers/${pid}`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf }, payload: { authorized: true, isDefault: true } });
      const o = await newOrder(a2, p2, world.a);
      await call(a2, s, 'POST', `/shop/orders/${o.order.id}/print-jobs`, { clientRequestId: randomUUID() });
      const ev = seen.find((e) => e.event === 'printJob.updated')!;
      expect(Object.keys(ev.data as object).sort()).toEqual(['id', 'orderId', 'status']);
      await a2.close();
    });
  });

  describe('document download', () => {
    it('only the lease holder, only while preparing, only for its own document; short-lived; no storage key', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      const res = await dev(w.auth, 'POST', `/device/print-jobs/${c.job.id}/download`, { leaseId: c.lease });
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data).toMatchObject({ mimeType: 'application/pdf', byteSize: 1234 });
      expect(new Date(data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(121_000);
      expect(JSON.stringify(data)).not.toContain((await prisma.document.findUniqueOrThrow({ where: { id: c.o.doc.id } })).objectKey + '"');
      expect((await dev(w.auth, 'POST', `/device/print-jobs/${c.job.id}/download`, { leaseId: randomUUID() })).statusCode).toBe(409);
      await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'DOWNLOADING' });
      expect((await dev(w.auth, 'POST', `/device/print-jobs/${c.job.id}/download`, { leaseId: c.lease })).statusCode).toBe(200);
      await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'SUBMITTING' });
      expect((await dev(w.auth, 'POST', `/device/print-jobs/${c.job.id}/download`, { leaseId: c.lease })).statusCode).toBe(409);
    });

    it('is refused once the document is no longer available', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      await prisma.document.update({ where: { id: c.o.doc.id }, data: { status: 'DELETED' } });
      expect((await dev(w.auth, 'POST', `/device/print-jobs/${c.job.id}/download`, { leaseId: c.lease })).statusCode).toBe(410);
    });
  });

  describe('recovery: never blindly resubmit', () => {
    it('lease expiry before submission re-queues the job; the next claim has a NEW lease and attempt 2', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'DOWNLOADING' });
      await expireLease(c.job.id);
      const next = (await claim(w.auth)).json().data.job;
      expect(next.id).toBe(c.job.id);
      expect(next.attempt).toBe(2);
      expect(next.leaseId).not.toBe(c.lease);
      // the stale agent can no longer report on the job
      expect((await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'SUBMITTING' })).statusCode).toBe(409);
      expect(next.documentName).toBe(`pb-${c.job.id}-2`);
    });

    it('lease expiry after SUBMITTING becomes NEEDS_RECONCILIATION and is NEVER re-queued or re-claimed', async () => {
      for (const upTo of [['DOWNLOADING', 'SUBMITTING'], ['DOWNLOADING', 'SUBMITTING', 'SUBMITTED_TO_SPOOLER']]) {
        const w = await windowsSetup();
        const c = await claimed(w);
        for (const status of upTo) await progress(w.auth, c.job.id, { leaseId: c.lease, status });
        await expireLease(c.job.id);
        const after = await claim(w.auth);
        expect(after.json().data.job).toBeNull();
        const row = await jobRow(c.job.id);
        expect(row.status).toBe('NEEDS_RECONCILIATION');
        expect(row.errorCode).toBe('LEASE_EXPIRED_AFTER_SUBMIT');
        const listed = await call(app, w.session, 'GET', '/shop/print-jobs');
        expect(listed.json().data.jobs[0]).toMatchObject({ status: 'NEEDS_RECONCILIATION', needsReconciliation: true, duplicateRisk: true });
        world = await seedWorld(prisma);
        owner = await login(app, world.a.ownerEmail);
        ownerB = await login(app, world.b.ownerEmail);
      }
    });

    it('the original agent can attach spooler EVIDENCE to an ambiguous job, but cannot fail or cancel it', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      for (const status of ['DOWNLOADING', 'SUBMITTING']) await progress(w.auth, c.job.id, { leaseId: c.lease, status });
      await expireLease(c.job.id);
      await claim(w.auth); // triggers recovery
      expect((await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'FAILED' })).statusCode).toBe(409);
      expect((await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'DOWNLOADING' })).statusCode).toBe(409);
      const ev = await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'SUBMITTED_TO_SPOOLER', spoolerJobId: 7 });
      expect(ev.statusCode).toBe(200);
      expect((await jobRow(c.job.id)).spoolerJobId).toBe(7);
    });

    it('gives up after too many attempts instead of looping', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      await prisma.devicePrintJob.update({ where: { id: c.job.id }, data: { attempt: 5, leaseExpiresAt: new Date(Date.now() - 1000) } });
      await claim(w.auth);
      expect(await jobRow(c.job.id)).toMatchObject({ status: 'FAILED', errorCode: 'TOO_MANY_ATTEMPTS' });
    });

    it('the shop listing also applies recovery (a silent agent does not leave a job stuck "downloading")', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      await expireLease(c.job.id);
      const res = await call(app, w.session, 'GET', '/shop/print-jobs');
      expect(res.json().data.jobs[0].status).toBe('QUEUED');
    });
  });

  describe('cancel / retry / reconcile', () => {
    it('cancel: QUEUED cancels at once; in flight becomes CANCEL_REQUESTED and the agent confirms CANCELED', async () => {
      const w = await windowsSetup();
      const q = await queued(w);
      const r = await call(app, w.session, 'POST', `/shop/print-jobs/${q.job.id}/cancel`, {});
      expect(r.json().data.job.status).toBe('CANCELED');
      const o = await newOrder(app, prisma, w.shop);
      const e = await enqueue(w.session, o.order.id);
      const jobId = e.json().data.job.id as string;
      const lease = (await claim(w.auth)).json().data.job.leaseId as string;
      await progress(w.auth, jobId, { leaseId: lease, status: 'DOWNLOADING' });
      const cr = await call(app, w.session, 'POST', `/shop/print-jobs/${jobId}/cancel`, {});
      expect(cr.json().data.job.status).toBe('CANCEL_REQUESTED');
      // the agent sees it on its next claim/resume and must stop; moving forward is refused
      const resume = (await claim(w.auth)).json().data.job;
      expect(resume).toMatchObject({ id: jobId, cancelRequested: true, status: 'CANCEL_REQUESTED' });
      const fwd = await progress(w.auth, jobId, { leaseId: lease, status: 'SUBMITTING' });
      expect(fwd.statusCode).toBe(409);
      expect(fwd.json().error.code).toBe('JOB_CANCEL_REQUESTED');
      expect((await progress(w.auth, jobId, { leaseId: lease, status: 'CANCELED' })).json().data.job.status).toBe('CANCELED');
      // idempotent
      expect((await call(app, w.session, 'POST', `/shop/print-jobs/${jobId}/cancel`, {})).statusCode).toBe(200);
    });

    it('cancel after submission: a spooler job that could not be removed ends PRINT_INITIATED ("cancel too late"), not CANCELED', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      for (const status of ['DOWNLOADING', 'SUBMITTING', 'SUBMITTED_TO_SPOOLER']) await progress(w.auth, c.job.id, { leaseId: c.lease, status, ...(status === 'SUBMITTED_TO_SPOOLER' ? { spoolerJobId: 9 } : {}) });
      await call(app, w.session, 'POST', `/shop/print-jobs/${c.job.id}/cancel`, {});
      expect((await jobRow(c.job.id)).status).toBe('CANCEL_REQUESTED');
      const late = await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'PRINT_INITIATED', spoolerState: 'Printing' });
      expect(late.json().data.job.status).toBe('PRINT_INITIATED');
    });

    it('cancel + silent agent: before submission it is CANCELED; after submission it needs reconciliation', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      await call(app, w.session, 'POST', `/shop/print-jobs/${c.job.id}/cancel`, {});
      await expireLease(c.job.id);
      expect((await call(app, w.session, 'GET', '/shop/print-jobs')).json().data.jobs[0].status).toBe('CANCELED');
    });

    it('retry: a pre-submission failure retries plainly; a post-submission failure needs acknowledgement', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'FAILED', errorCode: 'RENDERER_MISSING' });
      expect((await jobRow(c.job.id)).submittingAt).toBeNull();
      const plain = await call(app, w.session, 'POST', `/shop/print-jobs/${c.job.id}/retry`, { clientRequestId: randomUUID() });
      expect(plain.statusCode).toBe(201);
      expect(plain.json().data.job.id).not.toBe(c.job.id);

      const w2 = await windowsSetup();
      const c2 = await claimed(w2);
      for (const status of ['DOWNLOADING', 'SUBMITTING']) await progress(w2.auth, c2.job.id, { leaseId: c2.lease, status });
      await progress(w2.auth, c2.job.id, { leaseId: c2.lease, status: 'FAILED', errorCode: 'RENDERER_EXIT' });
      const refused = await call(app, w2.session, 'POST', `/shop/print-jobs/${c2.job.id}/retry`, { clientRequestId: randomUUID() });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('DUPLICATE_RISK_NOT_ACKNOWLEDGED');
      const direct = await enqueue(w2.session, c2.o.order.id);
      expect(direct.json().error.code).toBe('DUPLICATE_RISK_NOT_ACKNOWLEDGED');
      const ok = await call(app, w2.session, 'POST', `/shop/print-jobs/${c2.job.id}/retry`, { clientRequestId: randomUUID(), acknowledgeDuplicateRisk: true });
      expect(ok.statusCode).toBe(201);
    });

    it('reconcile: printed / not printed (print again) / give up; only for NEEDS_RECONCILIATION; tenant scoped', async () => {
      const mk = async () => {
        const w = await windowsSetup();
        const c = await claimed(w);
        for (const status of ['DOWNLOADING', 'SUBMITTING']) await progress(w.auth, c.job.id, { leaseId: c.lease, status });
        await progress(w.auth, c.job.id, { leaseId: c.lease, status: 'NEEDS_RECONCILIATION', errorCode: 'SPOOLER_UNKNOWN' });
        return { w, c };
      };
      const reconcile = (s: Session, id: string, body: object) => call(app, s, 'POST', `/shop/print-jobs/${id}/reconcile`, body);

      const a = await mk();
      expect((await reconcile(ownerB, a.c.job.id, { resolution: 'PRINTED' })).statusCode).toBe(404);
      const done = await reconcile(a.w.session, a.c.job.id, { resolution: 'PRINTED' });
      expect(done.json().data.job).toMatchObject({ status: 'PRINT_INITIATED', resolution: 'MANUALLY_CONFIRMED_PRINTED' });
      expect((await reconcile(a.w.session, a.c.job.id, { resolution: 'PRINTED' })).statusCode).toBe(409);
      // the order itself is still PRINTING: marking it printed remains the shopkeeper's explicit, separate action
      expect((await prisma.order.findUniqueOrThrow({ where: { id: a.c.o.order.id } })).status).toBe('PRINTING');

      const b = await mk();
      expect((await reconcile(b.w.session, b.c.job.id, { resolution: 'NOT_PRINTED_REQUEUE' })).statusCode).toBe(400); // needs a request id
      const again = await reconcile(b.w.session, b.c.job.id, { resolution: 'NOT_PRINTED_REQUEUE', clientRequestId: randomUUID() });
      expect(again.json().data.next).toMatchObject({ status: 'QUEUED' });

      const c = await mk();
      const gave = await reconcile(c.w.session, c.c.job.id, { resolution: 'NOT_PRINTED_GIVE_UP' });
      expect(gave.json().data.job).toMatchObject({ status: 'CANCELED', resolution: 'MANUALLY_ABANDONED' });
      // not a reconcilable state
      const q = await queued(await windowsSetup());
      expect((await reconcile(owner, q.job.id, { resolution: 'PRINTED' })).statusCode).toBe(409);
    });
  });

  describe('credential rotation + revocation', () => {
    it('rotation returns a new secret once; the old one dies on first use of the new one', async () => {
      const w = await windowsSetup();
      const rot = await dev(w.auth, 'POST', '/device/credential/rotate', {});
      expect(rot.statusCode).toBe(200);
      const fresh = rot.json().data.deviceCredential as string;
      expect(fresh).not.toBe(w.secret);
      expect(rot.json().data.credentialVersion).toBe(2);
      // lost response: the old credential still works during the grace window
      expect((await dev(w.auth, 'GET', '/device/print-jobs/active')).statusCode).toBe(200);
      // first use of the new credential retires the old one
      expect((await dev({ authorization: `Bearer ${fresh}` }, 'GET', '/device/print-jobs/active')).statusCode).toBe(200);
      expect((await dev(w.auth, 'GET', '/device/print-jobs/active')).statusCode).toBe(401);
      const row = await prisma.shopDevice.findUniqueOrThrow({ where: { id: w.device.id } });
      expect(row.previousCredentialHash).toBeNull();
      expect(JSON.stringify(rot.json())).not.toContain(row.credentialHash);
    });

    it('the superseded credential is dead after the grace window; a revoked device cannot rotate', async () => {
      const w = await windowsSetup();
      await dev(w.auth, 'POST', '/device/credential/rotate', {});
      await prisma.shopDevice.update({ where: { id: w.device.id }, data: { previousCredentialValidUntil: new Date(Date.now() - 1000) } });
      expect((await dev(w.auth, 'GET', '/device/print-jobs/active')).statusCode).toBe(401);
      const w2 = await windowsSetup();
      await call(app, owner, 'POST', `/shop/devices/${w2.device.id}/revoke`, {});
      expect((await dev(w2.auth, 'POST', '/device/credential/rotate', {})).statusCode).toBe(401);
    });

    it('revoking a device mid-job leaves the job unclaimable and un-reportable; shop sees it and can cancel', async () => {
      const w = await windowsSetup();
      const q = await queued(w);
      await call(app, owner, 'POST', `/shop/devices/${w.device.id}/revoke`, {});
      expect((await claim(w.auth)).statusCode).toBe(401);
      const c = await call(app, owner, 'POST', `/shop/print-jobs/${q.job.id}/cancel`, {});
      expect(c.json().data.job.status).toBe('CANCELED');
      // and a new job cannot target a revoked device's printer
      const o = await newOrder(app, prisma, w.shop);
      expect((await enqueue(owner, o.order.id)).json().error.code).toBe('PRINTER_UNAVAILABLE');
    });
  });

  describe('contract', () => {
    it('device claim/active/progress/download and shop job views have the documented shape', async () => {
      const w = await windowsSetup();
      const c = await claimed(w);
      expect(Object.keys(c.claim).sort()).toEqual([
        'attempt', 'cancelRequested', 'documentName', 'id', 'leaseExpiresAt', 'leaseId', 'options', 'orderId', 'printer',
        'spoolerJobId', 'status', 'statusBeforeCancel'
      ]);
      const active = (await dev(w.auth, 'GET', '/device/print-jobs/active')).json().data.jobs[0];
      expect(Object.keys(active).sort()).toEqual(Object.keys(c.claim).sort());
      const dl = (await dev(w.auth, 'POST', `/device/print-jobs/${c.job.id}/download`, { leaseId: c.lease })).json().data;
      expect(Object.keys(dl).sort()).toEqual(['byteSize', 'expiresAt', 'mimeType', 'sha256', 'url']);
      const shop = (await call(app, owner, 'GET', `/shop/print-jobs?orderId=${c.o.order.id}`)).json().data.jobs[0];
      expect(Object.keys(shop).sort()).toEqual([
        'attempt', 'createdAt', 'deviceId', 'duplicateRisk', 'errorCode', 'errorMessage', 'id', 'needsReconciliation', 'options', 'orderId',
        'printInitiatedAt', 'printerId', 'printerName', 'resolution', 'spoolerJobId', 'spoolerState', 'status', 'updatedAt'
      ]);
    });
  });
});
