import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildUploadsApp } from './fixtures/app.js';
import { makePdf } from './fixtures/make.js';
import { resetDb, testPrisma } from './helpers/db.js';

const prisma = testPrisma();
beforeEach(async () => {
  await resetDb(prisma);
  await prisma.shop.create({ data: { slug: 'copy-corner', displayName: 'Copy Corner' } });
});

describe('real socket: oversized upload is answered with 413, not a reset', () => {
  let ctx: Awaited<ReturnType<typeof buildUploadsApp>>;
  let port: number;
  beforeAll(async () => {
    ctx = await buildUploadsApp(prisma);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    port = (ctx.app.server.address() as AddressInfo).port;
  });
  afterAll(async () => ctx.close());

  it('streams chunked data past the declared size and gets FILE_TOO_LARGE', async () => {
    const init = await ctx.app.inject({ method: 'POST', url: '/api/v1/public/shops/copy-corner/uploads/initiate', payload: { fileName: 'a.pdf', byteSize: 2000, declaredMimeType: 'application/pdf' } });
    const url = new URL(init.json().data.uploadUrl, `http://127.0.0.1:${port}`);
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(url, { method: 'PUT', headers: { 'transfer-encoding': 'chunked', 'content-type': 'application/pdf' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      let n = 0;
      const write = () => {
        while (n++ < 200) if (!req.write(Buffer.alloc(1024, 1))) return void req.once('drain', write);
        req.end();
      };
      write();
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('createApp smoke', () => {
  it('upload plugins are registered in the real app: initiate -> PUT -> complete -> signed document fetch', async () => {
    const config = loadConfig({ ...process.env, PUBLIC_RATE_LIMIT_MAX: '1000', SSE_HEARTBEAT_MS: '60000' } as NodeJS.ProcessEnv);
    const { app } = createApp({ config, prisma });
    try {
      const pdf = await makePdf(2);
      const init = await app.inject({ method: 'POST', url: '/api/v1/public/shops/copy-corner/uploads/initiate', payload: { fileName: 'x.pdf', byteSize: pdf.length, declaredMimeType: 'application/pdf' } });
      expect(init.statusCode).toBe(200);
      const { uploadId, uploadUrl } = init.json().data;
      expect((await app.inject({ method: 'PUT', url: uploadUrl, payload: pdf, headers: { 'content-type': 'application/pdf' } })).statusCode).toBe(200);
      const done = await app.inject({ method: 'POST', url: `/api/v1/public/shops/copy-corner/uploads/${uploadId}/complete` });
      expect(done.json().data).toMatchObject({ pageCount: 2, documentStatus: 'AVAILABLE' });
      const doc = await prisma.document.findUniqueOrThrow({ where: { id: uploadId } });
      const access = await app.inject({ method: 'GET', url: (await (await import('../src/storage/index.js')).createStorage(config).temporaryReadUrl(doc.objectKey, 60)).url });
      expect(access.statusCode).toBe(200);
      expect(access.headers['content-type']).toBe('application/pdf');
    } finally {
      await app.close();
    }
  });
});
