import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startOfIstDay } from '../src/domain/time.js';
import { normaliseRanges } from '../src/domain/pricing.js';
import { ShopEvents } from '../src/events.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  SESSION_SECRET: 'a'.repeat(40),
  CSRF_SECRET: 'b'.repeat(40)
};
const prod = {
  ...base,
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://x.test',
  QUOTE_SECRET: 'c'.repeat(40),
  STORAGE_URL_SECRET: 'd'.repeat(40),
  TRUST_PROXY: 'false',
  ALLOW_LOCAL_STORAGE_IN_PRODUCTION: 'true'
};

describe('config', () => {
  it('refuses placeholder or short secrets in production', () => {
    expect(() => loadConfig(prod)).not.toThrow();
    expect(() => loadConfig({ ...prod, SESSION_SECRET: 'replace-with-a-long-random-local-secret' })).toThrow();
    expect(() => loadConfig({ ...prod, WEB_ORIGIN: 'http://x.test' })).toThrow();
    expect(() => loadConfig({ ...prod, CSRF_SECRET: 'a'.repeat(40) })).toThrow();
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow();
  });

  it('requires S3 settings only when STORAGE_DRIVER=s3', () => {
    expect(() => loadConfig({ ...base })).not.toThrow();
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    const ok = loadConfig({
      ...base,
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'auto',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      S3_FORCE_PATH_STYLE: 'true'
    });
    expect(ok.S3_FORCE_PATH_STYLE).toBe(true);
  });
});

describe('helpers', () => {
  it('IST day boundaries', () => {
    // 2026-10-04T20:00Z is 2026-10-05 01:30 IST => day starts 2026-10-04T18:30Z
    expect(startOfIstDay(new Date('2026-10-04T20:00:00Z')).toISOString()).toBe('2026-10-04T18:30:00.000Z');
    expect(startOfIstDay(new Date('2026-10-04T10:00:00Z')).toISOString()).toBe('2026-10-03T18:30:00.000Z');
  });

  it('page range normalisation is bounded and merges', () => {
    expect(normaliseRanges([{ from: 4, to: 6 }, { from: 1, to: 3 }], 10)).toEqual([{ from: 1, to: 6 }]);
    expect(() => normaliseRanges([{ from: 1, to: Number.MAX_SAFE_INTEGER }], 10)).toThrow();
  });

  it('event bus ring buffer replays only newer events', () => {
    const bus = new ShopEvents(3);
    const ids = [1, 2, 3, 4, 5].map((n) => bus.emit('s', 'order.updated', { n }));
    const got: string[] = [];
    bus.subscribe('s', { write: (c) => got.push(c), close: () => undefined }, ids[2]);
    expect(got.join('')).toContain('"n":4');
    expect(got.join('')).toContain('"n":5');
    expect(got.join('')).not.toContain('"n":3');
    const all: string[] = [];
    bus.subscribe('s', { write: (c) => all.push(c), close: () => undefined }, 0);
    expect(all.join('').match(/event:/g)).toHaveLength(3); // buffer size 3
  });
});
