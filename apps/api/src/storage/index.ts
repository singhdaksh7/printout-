import { deriveSecret } from './keys.js';
import { LocalStorage } from './local.js';
import { createS3Client, S3Storage } from './s3.js';
import type { Storage, StorageConfig } from './types.js';

export * from './types.js';
export * from './keys.js';
export { LocalStorage } from './local.js';
export { S3Storage, createS3Client } from './s3.js';

export function signatureMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return undefined;
}

const truthy = (v: unknown) => v === true || (typeof v === 'string' && ['1', 'true', 'yes'].includes(v.toLowerCase()));

export function createStorage(config: StorageConfig): Storage {
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
    return new S3Storage({
      bucket: config.S3_BUCKET,
      client: createS3Client({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        forcePathStyle: truthy(config.S3_FORCE_PATH_STYLE)
      })
    });
  }
  return new LocalStorage(config.LOCAL_UPLOAD_DIR ?? '.data/uploads', deriveSecret(config, 'document-read'), config.API_PREFIX ?? '/api/v1');
}
