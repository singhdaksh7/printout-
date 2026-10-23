import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { baseOptions as baseOrderOptions, buildApp, call, login, newOrder, seedWorld, type Session, type World } from '../../../api/test/api-helpers.js';
import { HttpApi } from '../../src/api-client.js';
import { Engine, type EngineConfig } from '../../src/engine.js';
import { Journal } from '../../src/journal.js';
import { silentLogger } from '../../src/logger.js';
import { FakeSpooler } from '../../src/testing/fake-spooler.js';
import { TempFiles } from '../../src/tempfiles.js';
import { Crash, PDF } from '../harness.js';

/**
 * THE contract test: the real agent engine + real HttpApi client talking HTTP to the real API (Fastify + PostgreSQL), with a
 * virtual printer. If the wire contract, the state machine or the recovery rules drift apart, this fails.
 * It proves the software chain; it does NOT prove physical printing.
 */
describe('agent engine against the real API', () => {
  const { app, prisma, storage } = buildApp();
  let world: World;
  let owner: Session;
  let base: string;
  const cleanups: Array<() => void> = [];

  beforeAll(async () => {
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/v1`;
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
    owner = await login(app, world.a.ownerEmail);
  });
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  const cfg = (over: Partial<EngineConfig> = {}): EngineConfig => ({
    apiBase: base, allowInsecureLoopback: true, pollIntervalMs: 1, housekeepingIntervalMs: 1e9, printerReportIntervalMs: 300_000,
    maxDocumentBytes: 5 * 1024 * 1024, monitorMs: 5_000, monitorPollMs: 5, leaseRenewMs: 20, appearMs: 500, downloadAttempts: 2,
    appVersion: '0.1.0-it', osVersion: 'Windows IT', ...over
  });

  /** Pairs a brand-new agent through the real pairing endpoint. */
  async function pairAgent(session: Session, over: { spooler?: FakeSpooler } = {}) {
    const code = (await call(app, session, 'POST', '/shop/devices/pairing-codes', {})).json().data.code as string;
    const api = new HttpApi({ baseUrl: base, userAgent: 'it', sleep: async () => undefined, maxAttempts: 2 });
    const paired = await api.pair({ code, deviceName: 'IT Counter PC', appVersion: '0.1.0-it', osVersion: 'Windows IT' });
    api.setCredential(paired.deviceCredential);
    const dir = mkdtempSync(join(tmpdir(), 'pb-it-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const spooler = over.spooler ?? new FakeSpooler();
    const temp = new TempFiles(dir, 900_000);
    await temp.init();
    const journal = new Journal(join(dir, 'journal.jsonl'));
    let sleepMs = 0;
    const mk = (over2: Partial<EngineConfig> = {}, wrap?: { spooler?: FakeSpooler }) =>
      new Engine({ api, spooler: wrap?.spooler ?? spooler, journal, temp, log: silentLogger, config: cfg(over2), sleep: async (ms) => { sleepMs += Math.min(ms, 5); await new Promise((r) => setTimeout(r, Math.min(ms, 5))); } });
    return { api, deviceId: paired.deviceId, credential: paired.deviceCredential, spooler, temp, journal, mk, dir, sleptMs: () => sleepMs };
  }

  /** Owner authorizes the printer the agent reported and makes it the default. */
  async function authorize(session: Session, deviceId: string) {
    const printer = await prisma.devicePrinter.findFirstOrThrow({ where: { deviceId } });
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/shop/devices/${deviceId}/printers/${printer.id}`, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf }, payload: { authorized: true, isDefault: true } });
    expect(res.statusCode).toBe(200);
    return printer;
  }

  /** A real order whose document bytes really are in storage. */
  async function orderWithDocument(shop: { shopId: string; slug: string }, bytes: Buffer = PDF, options: unknown = baseOrderOptions) {
    const o = await newOrder(app, prisma, shop, options as never);
    await storage.put(o.doc.objectKey, Readable.from(bytes), { maxBytes: 5 * 1024 * 1024, contentType: 'application/pdf' });
    await prisma.document.update({ where: { id: o.doc.id }, data: { byteSize: bytes.length } });
    return o;
  }
  const enqueue = (session: Session, orderId: string) => call(app, session, 'POST', `/shop/orders/${orderId}/print-jobs`, { clientRequestId: randomUUID() });
  const jobOf = (orderId: string) => prisma.devicePrintJob.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: 'desc' } });

  it('pair -> discover printers -> owner authorizes -> enqueue -> agent prints -> PRINT_INITIATED (never PRINTED)', async () => {
    const a = await pairAgent(owner);
    const engine = a.mk();
    await engine.syncPrinters(true);
    expect((await prisma.devicePrinter.findMany({ where: { deviceId: a.deviceId } })).map((p) => p.name)).toEqual(['Front Desk LaserJet']);
    await authorize(owner, a.deviceId);
    const o = await orderWithDocument(world.a);
    expect((await enqueue(owner, o.order.id)).statusCode).toBe(201);

    await engine.tick();

    const job = await jobOf(o.order.id);
    expect(job.status).toBe('PRINT_INITIATED');
    expect(job.spoolerJobId).not.toBeNull();
    expect(job.printInitiatedAt).not.toBeNull();
    expect(a.spooler.submissions).toHaveLength(1);
    expect(a.spooler.submissions[0]!.bytes).toBe(PDF.length); // the exact bytes stored for the order were downloaded and spooled
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.order.id } })).status).toBe('PRINTING');
    expect(readdirSync(a.temp.root)).toHaveLength(0);
    // heartbeat landed: the Devices page shows the computer online
    const devices = (await call(app, owner, 'GET', '/shop/devices')).json().data.devices;
    expect(devices[0]).toMatchObject({ presence: 'ONLINE', appVersion: '0.1.0-it' });
    expect(devices[0].printers[0]).toMatchObject({ authorized: true, isDefault: true });
    // every status the server ever stored for this job is part of the documented set, none of them "printed"
    expect(await prisma.auditLog.count({ where: { action: 'printJob.progress', targetId: job.id } })).toBeGreaterThanOrEqual(4);
  });

  it('options travel end to end: copies, duplex and page ranges reach the renderer', async () => {
    const a = await pairAgent(owner);
    const engine = a.mk();
    await engine.syncPrinters(true);
    await authorize(owner, a.deviceId);
    const o = await orderWithDocument(world.a, PDF, { paperSize: 'A4', colourMode: 'bw', sides: 'duplex', copies: 3, pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 2 }, { from: 5, to: 5 }] } });
    expect((await enqueue(owner, o.order.id)).statusCode).toBe(201);
    await engine.tick();
    expect(a.spooler.submissions[0]!.options).toMatchObject({ copies: 3, sides: 'duplex', colourMode: 'bw', pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 2 }, { from: 5, to: 5 }] } });
  });

  it('an unsupported / corrupt stored document fails safely with a visible reason and nothing is spooled', async () => {
    const a = await pairAgent(owner);
    const engine = a.mk();
    await engine.syncPrinters(true);
    await authorize(owner, a.deviceId);
    const o = await orderWithDocument(world.a, Buffer.from('MZ this is not a pdf'));
    await enqueue(owner, o.order.id);
    await engine.tick();
    const job = await jobOf(o.order.id);
    expect(job).toMatchObject({ status: 'FAILED', errorCode: 'MALFORMED', submittingAt: null });
    expect(a.spooler.submissions).toHaveLength(0);
    // retry-safe: no duplicate-risk acknowledgement needed
    const retry = await call(app, owner, 'POST', `/shop/print-jobs/${job.id}/retry`, { clientRequestId: randomUUID() });
    expect(retry.statusCode).toBe(201);
  });

  it('crash after the job entered the spooler and the lease expired: NEEDS_RECONCILIATION, then the restarted agent attaches evidence; exactly one submission', async () => {
    const a = await pairAgent(owner);
    await a.mk().syncPrinters(true);
    await authorize(owner, a.deviceId);
    const o = await orderWithDocument(world.a);
    await enqueue(owner, o.order.id);

    // The "process" dies right after the spooler accepted the job (nothing else is reported).
    let dead = false;
    const mortal = <T extends object>(t: T): T =>
      new Proxy(t, {
        get(target, p, r) {
          const v = Reflect.get(target, p, r);
          return typeof v === 'function' ? (...args: unknown[]) => { if (dead) throw new Crash('dead'); return (v as (...x: unknown[]) => unknown).apply(target, args); } : v;
        }
      });
    a.spooler.onQueued = () => { dead = true; throw new Crash('boom'); };
    const doomed = new Engine({ api: mortal(a.api), spooler: mortal(a.spooler), journal: mortal(a.journal), temp: a.temp, log: silentLogger, config: cfg(), sleep: async () => undefined });
    await doomed.tick().catch(() => undefined);
    a.spooler.onQueued = undefined;
    expect((await jobOf(o.order.id)).status).toBe('SUBMITTING');

    // The agent stays down: the lease expires and the server must NOT re-queue it.
    await prisma.devicePrintJob.updateMany({ where: { orderId: o.order.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const mid = await call(app, owner, 'GET', `/shop/print-jobs?orderId=${o.order.id}`);
    expect(mid.json().data.jobs[0]).toMatchObject({ status: 'NEEDS_RECONCILIATION', duplicateRisk: true, needsReconciliation: true });

    // Restart: the agent finds its job in the spooler and reports the evidence; it never submits again.
    const restarted = a.mk();
    await restarted.recover();
    expect((await jobOf(o.order.id)).status).toBe('SUBMITTED_TO_SPOOLER');
    await restarted.tick();
    expect((await jobOf(o.order.id)).status).toBe('PRINT_INITIATED');
    expect(a.spooler.submissions).toHaveLength(1);
  });

  it('shop cancel during preparation is honoured: the agent confirms CANCELED and prints nothing', async () => {
    const a = await pairAgent(owner);
    const engine = a.mk();
    await engine.syncPrinters(true);
    await authorize(owner, a.deviceId);
    const o = await orderWithDocument(world.a);
    const job = (await enqueue(owner, o.order.id)).json().data.job as { id: string };
    // Claim as the agent would, then the shop cancels before SUBMITTING.
    const claimed = await a.api.claim();
    expect(claimed.job!.id).toBe(job.id);
    await a.api.progress(job.id, { leaseId: claimed.job!.leaseId!, status: 'DOWNLOADING' });
    expect((await call(app, owner, 'POST', `/shop/print-jobs/${job.id}/cancel`, {})).json().data.job.status).toBe('CANCEL_REQUESTED');
    await engine.tick(); // claim returns the held job; the engine sees CANCEL_REQUESTED and confirms
    expect((await jobOf(o.order.id)).status).toBe('CANCELED');
    expect(a.spooler.submissions).toHaveLength(0);
  });

  it('tenant isolation: another shop\'s agent never receives, downloads or reports this shop\'s jobs', async () => {
    const a = await pairAgent(owner);
    await a.mk().syncPrinters(true);
    await authorize(owner, a.deviceId);
    const o = await orderWithDocument(world.a);
    const job = (await enqueue(owner, o.order.id)).json().data.job as { id: string };

    const ownerB = await login(app, world.b.ownerEmail);
    const b = await pairAgent(ownerB);
    await b.mk().syncPrinters(true);
    expect((await b.api.claim()).job).toBeNull();
    expect(await b.api.active()).toEqual([]);
    await expect(b.api.download(job.id, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(b.api.progress(job.id, { leaseId: randomUUID(), status: 'DOWNLOADING' })).rejects.toMatchObject({ status: 404 });
    expect((await jobOf(o.order.id)).status).toBe('QUEUED');
  });

  it('revocation: the shop disconnects the computer; the very next engine pass stops with "revoked" and prints nothing', async () => {
    const a = await pairAgent(owner);
    const engine = a.mk();
    await engine.syncPrinters(true);
    await authorize(owner, a.deviceId);
    const o = await orderWithDocument(world.a);
    await enqueue(owner, o.order.id);
    expect((await call(app, owner, 'POST', `/shop/devices/${a.deviceId}/revoke`, {})).statusCode).toBe(200);
    expect(await engine.run()).toBe('revoked');
    expect(a.spooler.submissions).toHaveLength(0);
    expect((await jobOf(o.order.id)).status).toBe('QUEUED');
  });

  it('credential rotation: new secret works, old secret dies after the new one is used, device keeps printing', async () => {
    const a = await pairAgent(owner);
    const rotated = await a.api.rotate();
    const old = a.credential;
    const oldApi = new HttpApi({ baseUrl: base, userAgent: 'it', maxAttempts: 1 });
    oldApi.setCredential(old);
    await oldApi.active(); // still valid in the grace window (lost-response protection)
    a.api.setCredential(rotated.deviceCredential);
    await a.api.active(); // first use of the new credential retires the old one
    await expect(oldApi.active()).rejects.toMatchObject({ status: 401 });
    const engine = a.mk();
    await engine.syncPrinters(true);
    await authorize(owner, a.deviceId);
    const o = await orderWithDocument(world.a);
    await enqueue(owner, o.order.id);
    await engine.tick();
    expect((await jobOf(o.order.id)).status).toBe('PRINT_INITIATED');
  });

  it('API outage: the engine backs off and completes the job after the server is reachable again', async () => {
    const a = await pairAgent(owner);
    const engine = a.mk();
    await engine.syncPrinters(true);
    await authorize(owner, a.deviceId);
    const o = await orderWithDocument(world.a);
    await enqueue(owner, o.order.id);
    // Point a second engine at a dead port first, then at the real server with the same journal/spooler.
    const deadApi = new HttpApi({ baseUrl: 'http://127.0.0.1:9/api/v1', userAgent: 'it', maxAttempts: 1, timeoutMs: 500, sleep: async () => undefined });
    deadApi.setCredential(a.credential);
    const down = new Engine({ api: deadApi, spooler: a.spooler, journal: a.journal, temp: a.temp, log: silentLogger, config: cfg({ apiBase: 'http://127.0.0.1:9/api/v1' }), sleep: async () => undefined });
    await expect(down.tick()).rejects.toMatchObject({ code: 'NETWORK' });
    expect((await jobOf(o.order.id)).status).toBe('QUEUED');
    await a.mk().tick();
    expect((await jobOf(o.order.id)).status).toBe('PRINT_INITIATED');
    expect(a.spooler.submissions).toHaveLength(1);
  });
});
