import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { haversineRepository, postgisInstalled, postgisRepository, selectGeoRepository } from '../src/domain/geo.js';

/**
 * PostGIS parity test (decision D4). Runs ONLY when POSTGIS_TEST_DATABASE_URL points at a disposable PostGIS-enabled database that has
 * the repository migrations applied (CI and the normal suite skip it). Example:
 *   docker run -d -e POSTGRES_PASSWORD=x -p 55498:5432 postgis/postgis:16-3.4
 *   DATABASE_URL=<url> prisma migrate deploy; POSTGIS_TEST_DATABASE_URL=<url> vitest run test/schema-v2-postgis.test.ts
 */
const url = process.env.POSTGIS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostGIS nearby parity with the portable haversine repository', () => {
  let db: PrismaClient;
  const points = [
    { id: 'gis-a', lat: 22.5726, lng: 88.3639 },
    { id: 'gis-b', lat: 22.7, lng: 88.4 },
    { id: 'gis-c', lat: 22.65, lng: 88.35 },
    { id: 'gis-d', lat: 28.6139, lng: 77.209 }, // Delhi: outside any Kolkata radius
    { id: 'gis-e', lat: 22.5731, lng: 88.3641 }
  ];
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$executeRawUnsafe(`DELETE FROM "Shop" WHERE id LIKE 'gis-%'`);
    for (const p of points) {
      await db.shop.create({ data: { id: p.id, slug: `${p.id}-slug`, displayName: p.id, status: 'ACTIVE', isVerified: true, latitude: p.lat, longitude: p.lng } });
    }
    await db.shop.create({ data: { id: 'gis-unverified', slug: 'gis-unverified', displayName: 'u', status: 'ACTIVE', isVerified: false, latitude: 22.5726, longitude: 88.3639 } });
  });
  afterAll(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "Shop" WHERE id LIKE 'gis-%'`);
    await db.$disconnect();
  });

  it('detects the extension', async () => {
    expect(await postgisInstalled(db)).toBe(true);
  });

  for (const radiusKm of [1, 5, 20]) {
    it(`returns the same shops in the same order within ${radiusKm} km`, async () => {
      const q = { lat: 22.5726, lng: 88.3639, radiusKm, limit: 50, offset: 0 };
      const a = await haversineRepository(db).nearby(q);
      const b = await postgisRepository(db).nearby(q);
      expect(b.rows.map((r) => r.id)).toEqual(a.rows.map((r) => r.id));
      expect(b.total).toBe(a.total);
      a.rows.forEach((r, i) => expect(Math.abs(r.distanceKm - b.rows[i]!.distanceKm)).toBeLessThanOrEqual(0.2));
    });
  }

  it('never returns unverified shops and honours pagination totals', async () => {
    const q = { lat: 22.5726, lng: 88.3639, radiusKm: 20, limit: 1, offset: 1 };
    const b = await postgisRepository(db).nearby(q);
    expect(b.rows).toHaveLength(1);
    expect(b.total).toBe(4);
    const beyond = await postgisRepository(db).nearby({ ...q, offset: 10 });
    expect(beyond).toEqual({ rows: [], total: 4 });
    expect((await postgisRepository(db).nearby({ ...q, limit: 50, offset: 0 })).rows.map((r) => r.id)).not.toContain('gis-unverified');
  });

  it('selectGeoRepository(postgis) uses PostGIS here, and the fallback answers identically when it is not requested', async () => {
    const q = { lat: 22.5726, lng: 88.3639, radiusKm: 20, limit: 50, offset: 0 };
    let fellBack = false;
    const sel = selectGeoRepository(db, 'postgis', () => (fellBack = true));
    expect((await sel.nearby(q)).rows.map((r) => r.id)).toEqual((await haversineRepository(db).nearby(q)).rows.map((r) => r.id));
    expect(fellBack).toBe(false);
  });
});

describe('selectGeoRepository fallback without PostGIS', () => {
  it('falls back to the portable repository and reports it when the extension check fails', async () => {
    let fellBack = 0;
    const calls: string[] = [];
    const fake = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        const text = strings.join('?');
        calls.push(text);
        if (text.includes('pg_extension')) return [{ ok: false }];
        return [];
      }
    } as unknown as PrismaClient;
    const sel = selectGeoRepository(fake, 'postgis', () => fellBack++);
    const out = await sel.nearby({ lat: 1, lng: 1, radiusKm: 5, limit: 10, offset: 0 });
    expect(out).toEqual({ rows: [], total: 0 });
    expect(fellBack).toBe(1);
    expect(calls.some((c) => c.includes('ST_DWithin'))).toBe(false);
    await sel.nearby({ lat: 1, lng: 1, radiusKm: 5, limit: 10, offset: 0 });
    expect(fellBack).toBe(1); // checked once
  });
});
