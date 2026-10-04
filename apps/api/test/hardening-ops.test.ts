import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DocumentStatus, OrderStatus } from '@prisma/client';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { verifyPassword } from '../src/auth.js';
import { configWarnings, loadConfig, UPLOAD_HARD_CEILING_BYTES } from '../src/config.js';
import { documentAccessWindow } from '../src/domain/access.js';
import { createS3Client, generateObjectKey, LocalStorage, S3Storage, type Storage } from '../src/storage/index.js';
import { bootstrapAdmin, BootstrapError, passwordProblem } from '../prisma/bootstrap-admin.js';
import { advance, buildApp, call, login, newOrder, seedWorld, testConfig, type World } from './api-helpers.js';
import { buildUploadsApp } from './fixtures/app.js';
import { resetDb, testPrisma } from './helpers/db.js';

const prisma = testPrisma();
const API_DIR = path.resolve(import.meta.dirname, '..');

const prodEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://printout:s3cure-pw-9@db:5432/printout',
  SESSION_SECRET: 'p'.repeat(20) + 'Zq8vK2mXw9LrT4bN7cYd',
  CSRF_SECRET: 'c'.repeat(20) + 'Hj3sF6gUe1PaV5oRt0Ik',
  QUOTE_SECRET: 'q'.repeat(20) + 'Bd4nM7xLc2WqE9rYh5Tz',
  STORAGE_URL_SECRET: 's'.repeat(20) + 'Kf8aG1vXj6NpU3yDo2Rb',
  WEB_ORIGIN: 'https://print.example.org',
  TRUST_PROXY_CIDRS: 'loopback,linklocal,uniquelocal',
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_REGION: 'auto',
  S3_BUCKET: 'printout-docs',
  S3_ACCESS_KEY_ID: 'AKIAREALKEYID0123456',
  S3_SECRET_ACCESS_KEY: 'zZ9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF'
} as Record<string, string>;

describe('production config contract (fail closed, clear list, no values)', () => {
  it('accepts a complete production environment', () => {
    const cfg = loadConfig(prodEnv);
    expect(cfg.NODE_ENV).toBe('production');
    expect(cfg.TRUST_PROXY_CIDRS).toBe('loopback,linklocal,uniquelocal');
    expect(cfg.TRUST_PROXY).toBe(false);
  });

  it('lists every problem at once and never prints secret values', () => {
    let message = '';
    try {
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://printout:change-me@db:5432/printout',
        SESSION_SECRET: 'replace-with-a-long-random-local-secret',
        CSRF_SECRET: 'replace-with-a-long-random-local-secret',
        WEB_ORIGIN: 'http://localhost:5173',
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: 'http://minio:9000',
        S3_REGION: 'auto',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY_ID: 'replace-me',
        S3_SECRET_ACCESS_KEY: 'replace-me'
      });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ['SESSION_SECRET', 'CSRF_SECRET', 'QUOTE_SECRET', 'DATABASE_URL', 'WEB_ORIGIN', 'TRUST_PROXY', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID']) {
      expect(message, name).toContain(name);
    }
    expect(message).not.toContain('replace-with-a-long-random-local-secret');
    expect(message).not.toContain('change-me');
  });

  it.each([
    ['SESSION_SECRET', undefined],
    ['CSRF_SECRET', undefined],
    ['QUOTE_SECRET', undefined],
    ['DATABASE_URL', undefined],
    ['WEB_ORIGIN', 'http://print.example.org'],
    ['WEB_ORIGIN', 'https://localhost'],
    ['S3_BUCKET', undefined],
    ['S3_ENDPOINT', 'http://insecure.example.org'],
    ['S3_SECRET_ACCESS_KEY', 'replace-me'],
    ['SESSION_SECRET', 'short'],
    ['QUOTE_SECRET', 'q'.repeat(10)]
  ])('rejects production with %s = %s', (key, value) => {
    const env = { ...prodEnv };
    if (value === undefined) delete env[key];
    else env[key] = value;
    expect(() => loadConfig(env)).toThrow(key);
  });

  it('requires distinct secrets', () => {
    expect(() => loadConfig({ ...prodEnv, QUOTE_SECRET: prodEnv.SESSION_SECRET })).toThrow(/QUOTE_SECRET must differ/);
    expect(() => loadConfig({ ...prodEnv, CSRF_SECRET: prodEnv.SESSION_SECRET })).toThrow(/CSRF_SECRET must differ/);
    expect(() => loadConfig({ ...prodEnv, STORAGE_URL_SECRET: prodEnv.QUOTE_SECRET })).toThrow(/STORAGE_URL_SECRET must differ/);
  });

  it('proxy trust must be explicit in production, local dev needs nothing', () => {
    const env = { ...prodEnv };
    delete env.TRUST_PROXY_CIDRS;
    expect(() => loadConfig(env)).toThrow(/TRUST_PROXY/);
    expect(loadConfig({ ...env, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    const blind = loadConfig({ ...env, TRUST_PROXY: 'true' });
    expect(blind.TRUST_PROXY).toBe(true);
    expect(configWarnings(blind).join(' ')).toMatch(/TRUST_PROXY=true/);
    expect(loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db', SESSION_SECRET: 'a'.repeat(40), CSRF_SECRET: 'b'.repeat(40) }).TRUST_PROXY).toBe(false);
  });

  it('local storage in production needs an explicit acknowledgement (and its own URL secret)', () => {
    const local = { ...prodEnv, STORAGE_DRIVER: 'local' };
    expect(() => loadConfig(local)).toThrow(/ALLOW_LOCAL_STORAGE_IN_PRODUCTION/);
    const ok = loadConfig({ ...local, ALLOW_LOCAL_STORAGE_IN_PRODUCTION: 'true' });
    expect(configWarnings(ok).join(' ')).toMatch(/STORAGE_DRIVER=local/);
    const noUrlSecret = { ...local, ALLOW_LOCAL_STORAGE_IN_PRODUCTION: 'true' } as Record<string, string>;
    delete noUrlSecret.STORAGE_URL_SECRET;
    expect(() => loadConfig(noUrlSecret)).toThrow(/STORAGE_URL_SECRET/);
  });

  it('refuses an upload cap above the hard ceiling and keeps the 50 MiB default', () => {
    expect(loadConfig(prodEnv).UPLOAD_MAX_BYTES).toBe(52_428_800);
    expect(loadConfig({ ...prodEnv, UPLOAD_MAX_BYTES: String(UPLOAD_HARD_CEILING_BYTES) }).UPLOAD_MAX_BYTES).toBe(UPLOAD_HARD_CEILING_BYTES);
    expect(() => loadConfig({ ...prodEnv, UPLOAD_MAX_BYTES: String(UPLOAD_HARD_CEILING_BYTES + 1) })).toThrow(/UPLOAD_MAX_BYTES/);
    expect(configWarnings(loadConfig({ ...prodEnv, UPLOAD_MAX_BYTES: '83886080' })).join(' ')).toMatch(/proxy body cap/);
  });

  it('the worker process uses the same validation and exits non-zero with a clear message', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
      cwd: API_DIR,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', DATABASE_URL: 'postgresql://printout:change-me@db/x', SESSION_SECRET: 'replace-me-with-something-long-enough-xx' },
      encoding: 'utf8',
      timeout: 60_000
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Invalid configuration');
    expect(run.stderr).toContain('CSRF_SECRET');
    expect(run.stderr).not.toContain('replace-me-with-something');
    expect(run.stderr).not.toContain('change-me');
  });
});

describe('temporary document URL lifetime never exceeds the deletion deadline', () => {
  const now = Date.parse('2026-10-04T12:00:00.000Z');
  const printed = (deleteAfterMs: number) => ({ status: DocumentStatus.PRINTED_RETENTION, printedAt: new Date(now - 1000), expiresAt: new Date(now + 86_400_000), deleteAfter: new Date(deleteAfterMs) });

  it('TTL = min(300, whole seconds to deleteAfter) and refuses at/after the boundary', () => {
    expect(documentAccessWindow(printed(now + 29 * 60_000), OrderStatus.PRINTED, now)?.ttlSeconds).toBe(300);
    expect(documentAccessWindow(printed(now + 300_000), OrderStatus.PRINTED, now)?.ttlSeconds).toBe(300);
    expect(documentAccessWindow(printed(now + 299_999), OrderStatus.PRINTED, now)?.ttlSeconds).toBe(299);
    expect(documentAccessWindow(printed(now + 42_500), OrderStatus.PRINTED, now)?.ttlSeconds).toBe(42);
    expect(documentAccessWindow(printed(now + 1000), OrderStatus.PRINTED, now)?.ttlSeconds).toBe(1);
    expect(documentAccessWindow(printed(now + 999), OrderStatus.PRINTED, now)).toBeNull(); // < 1s left
    expect(documentAccessWindow(printed(now), OrderStatus.PRINTED, now)).toBeNull(); // exactly at deleteAfter
    expect(documentAccessWindow(printed(now - 1), OrderStatus.PRINTED, now)).toBeNull();
  });

  it('unprinted documents are bounded by expiresAt (and by deleteAfter if ever set)', () => {
    const unprinted = (expiresAtMs: number, deleteAfterMs?: number) => ({
      status: DocumentStatus.AVAILABLE,
      printedAt: null,
      expiresAt: new Date(expiresAtMs),
      deleteAfter: deleteAfterMs ? new Date(deleteAfterMs) : null
    });
    expect(documentAccessWindow(unprinted(now + 10_000), OrderStatus.NEW, now)?.ttlSeconds).toBe(10);
    expect(documentAccessWindow(unprinted(now + 10_000, now + 3_000), OrderStatus.NEW, now)?.ttlSeconds).toBe(3);
    expect(documentAccessWindow(unprinted(now + 10_000, now + 3_000), OrderStatus.NEW, now)?.deadline.getTime()).toBe(now + 3_000);
    expect(documentAccessWindow(unprinted(now), OrderStatus.NEW, now)).toBeNull();
    expect(documentAccessWindow(unprinted(now + 500), OrderStatus.NEW, now)).toBeNull();
    expect(documentAccessWindow(unprinted(now + 86_400_000), OrderStatus.NEW, now)?.ttlSeconds).toBe(300);
  });

  it('refuses deleted/failed/uploading documents and cancelled/expired orders', () => {
    for (const status of [DocumentStatus.DELETED, DocumentStatus.FAILED, DocumentStatus.UPLOADING]) {
      expect(documentAccessWindow({ status, printedAt: null, expiresAt: new Date(now + 60_000), deleteAfter: new Date(now + 60_000) }, OrderStatus.NEW, now)).toBeNull();
    }
    expect(documentAccessWindow(printed(now + 60_000), OrderStatus.CANCELLED, now)).toBeNull();
    expect(documentAccessWindow(printed(now + 60_000), OrderStatus.EXPIRED, now)).toBeNull();
  });
});

describe('document-access route passes the capped TTL to storage and refuses at the boundary', () => {
  let world: World;
  beforeEach(async () => {
    world = await seedWorld(prisma);
  });

  const spyStorage = () => {
    const calls: Array<{ key: string; seconds: number }> = [];
    const storage = {
      temporaryReadUrl: async (key: string, seconds: number) => {
        calls.push({ key, seconds });
        return { url: 'https://signed.invalid/x', expiresAt: new Date(Date.now() + seconds * 1000) };
      }
    } as unknown as Storage;
    return { calls, storage };
  };

  async function printedOrder(app: ReturnType<typeof buildApp>['app'], deleteAfterMs: number) {
    const shop = await login(app, world.a.ownerEmail);
    const { order, doc } = await newOrder(app, prisma, world.a);
    await advance(app, shop, order.id, 'ACCEPTED', 'PRINTING');
    await prisma.document.update({
      where: { id: doc.id },
      data: { status: DocumentStatus.PRINTED_RETENTION, printedAt: new Date(), deleteAfter: new Date(deleteAfterMs) }
    });
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PRINTED } });
    return { shop, order };
  }

  it('caps at min(300s, time to deleteAfter); the response expiresAt never exceeds deleteAfter', async () => {
    const { calls, storage } = spyStorage();
    const { app } = { app: createApp({ config: testConfig(), prisma, storage }).app };
    try {
      const deleteAfter = Date.now() + 45_500;
      const { shop, order } = await printedOrder(app, deleteAfter);
      const res = await call(app, shop, 'POST', `/shop/orders/${order.id}/document-access`, {});
      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.seconds).toBeLessThanOrEqual(45);
      expect(calls[0]!.seconds).toBeGreaterThanOrEqual(43);
      expect(new Date(res.json().data.expiresAt).getTime()).toBeLessThanOrEqual(deleteAfter);

      const far = await printedOrder(app, Date.now() + 29 * 60_000);
      await call(app, far.shop, 'POST', `/shop/orders/${far.order.id}/document-access`, {});
      expect(calls.at(-1)!.seconds).toBe(300);
    } finally {
      await app.close();
    }
  });

  it('answers 410 DOCUMENT_UNAVAILABLE (and never calls storage) with under a second left', async () => {
    const { calls, storage } = spyStorage();
    const app = createApp({ config: testConfig(), prisma, storage }).app;
    try {
      const { shop, order } = await printedOrder(app, Date.now() + 600);
      const res = await call(app, shop, 'POST', `/shop/orders/${order.id}/document-access`, {});
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('DOCUMENT_UNAVAILABLE');
      expect(calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe('S3 adapter semantics', () => {
  const s3 = mockClient(S3Client);
  const client = createS3Client({ endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', accessKeyId: 'AKIATESTKEY0123456', secretAccessKey: 'super-secret-access-key-value', forcePathStyle: true });
  const storage = new S3Storage({ bucket: 'printout-private', client });
  beforeEach(() => s3.reset());

  it('presigned GET lifetime is capped (300s), floored (1s) and never exceeds what the caller asked', async () => {
    const key = generateObjectKey();
    const expires = async (seconds: number) => Number(new URL((await storage.temporaryReadUrl(key, seconds)).url).searchParams.get('X-Amz-Expires'));
    expect(await expires(604_800)).toBe(300);
    expect(await expires(301)).toBe(300);
    expect(await expires(300)).toBe(300);
    expect(await expires(45.9)).toBe(45);
    expect(await expires(0.4)).toBe(1);
    const before = Date.now();
    const { expiresAt } = await storage.temporaryReadUrl(key, 20);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(before + 20_000 + 50);
  });

  it('only a missing OBJECT counts as not-found: NoSuchBucket / AccessDenied / 5xx surface as errors', async () => {
    const key = generateObjectKey();
    const err = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
    s3.on(DeleteObjectCommand).rejects(err('NoSuchKey', 404));
    await expect(storage.delete(key)).resolves.toBeUndefined();
    for (const [name, status] of [['NoSuchBucket', 404], ['AccessDenied', 403], ['InternalError', 500], ['SlowDown', 503]] as const) {
      s3.reset();
      s3.on(DeleteObjectCommand).rejects(err(name, status));
      await expect(storage.delete(key), name).rejects.toThrow(name);
    }
    s3.reset();
    s3.on(HeadObjectCommand).rejects(err('NoSuchBucket', 404));
    await expect(storage.head(key)).rejects.toThrow('NoSuchBucket');
    s3.reset();
    s3.on(HeadObjectCommand).rejects(err('NotFound', 404));
    expect(await storage.head(key)).toBeNull();
  });

  it('has bounded retries and timeouts, and the client never exposes credentials through errors', async () => {
    expect(await client.config.maxAttempts()).toBe(3);
    const key = generateObjectKey();
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    const error = await storage.head(key).catch((e) => e as Error);
    expect(String((error as Error).message) + String((error as Error).stack)).not.toMatch(/super-secret-access-key-value|AKIATESTKEY0123456/);
  });

  it('local driver applies the same TTL cap', async () => {
    const local = new LocalStorage(path.join(API_DIR, '.data/test-uploads'), 'k');
    const { url, expiresAt } = await local.temporaryReadUrl(generateObjectKey(), 99_999);
    expect(Number(new URL(url, 'http://x').searchParams.get('exp')) * 1000 - Date.now()).toBeLessThanOrEqual(300_000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
  });
});

describe('upload size layers agree (raw PUT, app limit is authoritative)', () => {
  let ctx: Awaited<ReturnType<typeof buildUploadsApp>>;
  let port: number;
  beforeAll(async () => {
    await resetDb(prisma);
    await prisma.shop.create({ data: { slug: 'copy-corner', displayName: 'Copy Corner' } });
    ctx = await buildUploadsApp(prisma, { UPLOAD_MAX_BYTES: 5000 });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    port = (ctx.app.server.address() as AddressInfo).port;
  });
  afterAll(async () => ctx.close());

  const initiate = async (byteSize: number) => {
    const init = await ctx.app.inject({ method: 'POST', url: '/api/v1/public/shops/copy-corner/uploads/initiate', payload: { fileName: 'a.pdf', byteSize, declaredMimeType: 'application/pdf' } });
    return init;
  };
  const put = (uploadUrl: string, headers: Record<string, string>, write: (req: http.ClientRequest) => void) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(new URL(uploadUrl, `http://127.0.0.1:${port}`), { method: 'PUT', headers: { 'content-type': 'application/pdf', ...headers } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          resolve({ status: res.statusCode!, body });
          req.destroy();
        });
      });
      req.on('error', reject);
      write(req);
    });

  it('initiate rejects a declared size above the cap with 413 FILE_TOO_LARGE', async () => {
    const res = await initiate(5001);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
    const ok = await initiate(5000);
    expect(ok.json().data.limits.maxBytes).toBe(5000);
  });

  it('a lying (huge) Content-Length is refused up-front with 413, without reading the body', async () => {
    const init = await initiate(5000);
    const result = await put(init.json().data.uploadUrl, { 'content-length': '999999999' }, (req) => {
      req.flushHeaders();
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).error.code).toBe('FILE_TOO_LARGE');
  });

  it('chunked body without Content-Length is cut off at the cap even when declared == cap', async () => {
    const init = await initiate(5000);
    const result = await put(init.json().data.uploadUrl, { 'transfer-encoding': 'chunked' }, (req) => {
      let n = 0;
      const write = () => {
        while (n++ < 50) if (!req.write(Buffer.alloc(1000, 1))) return void req.once('drain', write);
        req.end();
      };
      write();
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).error.code).toBe('FILE_TOO_LARGE');
    // nothing was stored and the document is no longer completable
    const id = init.json().data.uploadId as string;
    expect((await prisma.document.findUniqueOrThrow({ where: { id } })).status).toBe(DocumentStatus.FAILED);
  });

  it('Caddy cap guidance: UPLOAD_MAX_BYTES default 50 MiB, hard ceiling 100 MiB, so proxy max_size = UPLOAD_MAX_BYTES + 1 MiB', () => {
    expect(loadConfig(prodEnv).UPLOAD_MAX_BYTES + 1_048_576).toBe(53_477_376);
    expect(UPLOAD_HARD_CEILING_BYTES).toBe(104_857_600);
  });
});

describe('bootstrap-admin', () => {
  beforeEach(() => resetDb(prisma));
  const env = { ADMIN_EMAIL: 'Root@Example-Corp.test', ADMIN_PASSWORD: 'Tr0ub4dor&3-horse-staple' } as const;

  it('creates an Argon2id platform admin, normalises the email and audit-logs it', async () => {
    const result = await bootstrapAdmin(prisma, { ...env });
    expect(result.outcome).toBe('created');
    expect(result.message).not.toContain(env.ADMIN_PASSWORD);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'root@example-corp.test' } });
    expect(user.role).toBe('PLATFORM_ADMIN');
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(user.passwordHash, env.ADMIN_PASSWORD)).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'admin.bootstrap.create', targetId: user.id } })).toBe(1);
  });

  it('is idempotent: an existing admin is a no-op unless ADMIN_RESET_PASSWORD=1 (which also ends sessions)', async () => {
    await bootstrapAdmin(prisma, { ...env });
    const before = await prisma.user.findUniqueOrThrow({ where: { email: 'root@example-corp.test' } });
    const again = await bootstrapAdmin(prisma, { ...env, ADMIN_PASSWORD: 'A-completely-different-pw-77' });
    expect(again.outcome).toBe('exists');
    expect(again.message).toMatch(/already exists/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: before.id } })).passwordHash).toBe(before.passwordHash);
    const session = await prisma.session.create({ data: { userId: before.id, tokenHash: 'h'.repeat(64), expiresAt: new Date(Date.now() + 1e6) } });
    const reset = await bootstrapAdmin(prisma, { ...env, ADMIN_PASSWORD: 'A-completely-different-pw-77', ADMIN_RESET_PASSWORD: '1' });
    expect(reset.outcome).toBe('reset');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: before.id } });
    expect(await verifyPassword(after.passwordHash, 'A-completely-different-pw-77')).toBe(true);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).invalidatedAt).not.toBeNull();
  });

  it('still creates this admin when another admin exists, and says so', async () => {
    await bootstrapAdmin(prisma, { ...env });
    const second = await bootstrapAdmin(prisma, { ...env, ADMIN_EMAIL: 'second@example-corp.test' });
    expect(second.outcome).toBe('created');
    expect(second.message).toMatch(/1 other platform admin/);
    expect(await prisma.user.count({ where: { role: 'PLATFORM_ADMIN' } })).toBe(2);
  });

  it('refuses to touch a non-admin account with that email', async () => {
    const shop = await prisma.shop.create({ data: { slug: 'some-shop', displayName: 'S' } });
    await prisma.user.create({ data: { email: 'owner@example-corp.test', displayName: 'O', passwordHash: 'x', role: 'SHOP_OWNER', shopId: shop.id } });
    await expect(bootstrapAdmin(prisma, { ...env, ADMIN_EMAIL: 'owner@example-corp.test' })).rejects.toThrow(/not a PLATFORM_ADMIN/);
  });

  it('has no default password and rejects weak / placeholder values and bad emails', async () => {
    await expect(bootstrapAdmin(prisma, { ADMIN_EMAIL: env.ADMIN_EMAIL })).rejects.toThrow(/ADMIN_PASSWORD is required/);
    for (const bad of ['short-pw-1', 'change-this-development-password', 'aaaaaaaaaaaaaaaa', 'password1234', 'x'.repeat(300), 'root-and-more-text-1']) {
      await expect(bootstrapAdmin(prisma, { ...env, ADMIN_PASSWORD: bad }), bad).rejects.toBeInstanceOf(BootstrapError);
    }
    await expect(bootstrapAdmin(prisma, { ADMIN_PASSWORD: env.ADMIN_PASSWORD })).rejects.toThrow(/ADMIN_EMAIL/);
    await expect(bootstrapAdmin(prisma, { ...env, ADMIN_EMAIL: 'nope' })).rejects.toThrow(/ADMIN_EMAIL/);
    expect(passwordProblem('Tr0ub4dor&3-horse-staple', 'a@b.test')).toBeUndefined();
    expect(await prisma.user.count()).toBe(0);
  });

  it('refuses NODE_ENV=production without an explicit DATABASE_URL', async () => {
    await expect(bootstrapAdmin(prisma, { ...env, NODE_ENV: 'production' })).rejects.toThrow(/DATABASE_URL/);
    expect((await bootstrapAdmin(prisma, { ...env, NODE_ENV: 'production', DATABASE_URL: 'postgresql://x' })).outcome).toBe('created');
  });

  it('CLI: meaningful exit codes and the password never appears in output', () => {
    const base = { PATH: process.env.PATH ?? '', DATABASE_URL: process.env.DATABASE_URL ?? '' };
    const run = (extra: Record<string, string>) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'prisma/bootstrap-admin.ts'], { cwd: API_DIR, env: { ...base, ...extra }, encoding: 'utf8', timeout: 90_000, input: '' });
    const created = run({ ADMIN_EMAIL: 'cli@example-corp.test', ADMIN_PASSWORD: 'Tr0ub4dor&3-horse-staple' });
    expect(created.status).toBe(0);
    expect(created.stdout).toContain('Created platform admin cli@example-corp.test');
    const again = run({ ADMIN_EMAIL: 'cli@example-corp.test', ADMIN_PASSWORD: 'Tr0ub4dor&3-horse-staple' });
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/already exists/);
    const noPw = run({ ADMIN_EMAIL: 'cli2@example-corp.test' });
    expect(noPw.status).toBe(2);
    const weak = run({ ADMIN_EMAIL: 'cli3@example-corp.test', ADMIN_PASSWORD: 'weakpw' });
    expect(weak.status).toBe(2);
    const noDb = run({ NODE_ENV: 'production', DATABASE_URL: '', ADMIN_EMAIL: 'cli4@example-corp.test', ADMIN_PASSWORD: 'Tr0ub4dor&3-horse-staple' });
    expect(noDb.status).toBe(2);
    const unreachable = run({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/none', ADMIN_EMAIL: 'cli5@example-corp.test', ADMIN_PASSWORD: 'Tr0ub4dor&3-horse-staple' });
    expect(unreachable.status).toBe(1);
    for (const r of [created, again, noPw, weak, noDb, unreachable]) {
      expect(r.stdout + r.stderr).not.toContain('Tr0ub4dor');
      expect(r.stdout + r.stderr).not.toContain('weakpw');
    }
  }, 180_000);
});
