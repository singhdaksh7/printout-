import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { registerErrorHandlers } from '../../src/errors.js';
import { internalStorageRoutes } from '../../src/internal-storage.js';
import { LocalStorage } from '../../src/storage/index.js';
import { uploadRoutes, type UploadsConfig } from '../../src/uploads.js';

export const testUploadConfig = (over: Partial<UploadsConfig> = {}): UploadsConfig => ({
  SESSION_SECRET: 'test-session-secret-0123456789abcdefghij',
  UPLOAD_MAX_BYTES: 1_000_000,
  UPLOAD_MAX_PDF_PAGES: 5,
  UNPRINTED_RETENTION_HOURS: 24,
  PUBLIC_RATE_LIMIT_MAX: 1000,
  UPLOAD_INITIATE_RATE_LIMIT_MAX: 1000,
  ...over
});

/** Minimal Fastify app with only the FILES plugins, a real Prisma client and a temp local storage dir. */
export async function buildUploadsApp(prisma: PrismaClient, over: Partial<UploadsConfig> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'printout-up-'));
  const config = testUploadConfig(over);
  const storage = new LocalStorage(dir, 'unit-test-read-secret');
  const app = Fastify({ logger: false });
  registerErrorHandlers(app);
  await app.register(rateLimit, { global: false });
  await app.register(uploadRoutes, { prefix: '/api/v1', prisma, storage, config });
  await app.register(internalStorageRoutes, { prefix: '/api/v1', prisma, storage, config });
  await app.ready();
  return {
    app,
    storage,
    config,
    dir,
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** initiate -> PUT -> returns ids; completion left to the caller. */
export async function uploadFile(
  app: Awaited<ReturnType<typeof buildUploadsApp>>['app'],
  slug: string,
  file: Buffer,
  mime: string,
  fileName = 'doc.pdf'
) {
  const init = await app.inject({ method: 'POST', url: `/api/v1/public/shops/${slug}/uploads/initiate`, payload: { fileName, byteSize: file.length, declaredMimeType: mime } });
  if (init.statusCode !== 200) return { init };
  const { uploadId, uploadUrl } = init.json().data;
  const put = await app.inject({ method: 'PUT', url: uploadUrl, payload: file, headers: { 'content-type': mime } });
  return { init, put, uploadId: uploadId as string, uploadUrl: uploadUrl as string };
}
