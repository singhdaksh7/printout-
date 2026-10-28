import { Prisma, type PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export const EARTH_RADIUS_KM = 6371;
export const DEFAULT_RADIUS_KM = 5;
export const MAX_RADIUS_KM = 20;

export interface NearbyQuery {
  lat: number;
  lng: number;
  radiusKm: number;
  /** Only shops that have an active rate for this colour mode (`bw` | `colour`). */
  colourMode?: 'bw' | 'colour';
  limit: number;
  offset: number;
}

export interface NearbyRow {
  id: string;
  distanceKm: number;
}

/**
 * Geographic search behind one interface (decision D4): the portable implementation below needs no extension. A PostGIS-backed
 * implementation (ST_DWithin + GiST) may replace it once the extension is verified on the target database; callers do not change.
 * Contract: only verified, ACTIVE shops that have coordinates; ordered by distance (then id); `total` counts all matches.
 */
export interface ShopGeoRepository {
  nearby(q: NearbyQuery): Promise<{ rows: NearbyRow[]; total: number }>;
}

/** Bounding box (degrees) that contains every point within radiusKm; longitude is unbounded when the box would wrap the antimeridian or a pole. */
export function boundingBox(lat: number, lng: number, radiusKm: number) {
  const dLat = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const minLat = Math.max(-90, lat - dLat);
  const maxLat = Math.min(90, lat + dLat);
  const cos = Math.cos((lat * Math.PI) / 180);
  if (cos < 1e-6 || maxLat >= 90 || minLat <= -90) return { minLat, maxLat, minLng: null, maxLng: null };
  const dLng = dLat / cos;
  const minLng = lng - dLng;
  const maxLng = lng + dLng;
  if (minLng < -180 || maxLng > 180) return { minLat, maxLat, minLng: null, maxLng: null };
  return { minLat, maxLat, minLng, maxLng };
}

/** Haversine on the spherical earth; the bounding box lets the (isVerified, status) / (latitude, longitude) indexes prune first. */
export function haversineRepository(db: Db): ShopGeoRepository {
  return {
    async nearby(q) {
      const box = boundingBox(q.lat, q.lng, q.radiusKm);
      const lngFilter = box.minLng === null ? Prisma.empty : Prisma.sql`AND s."longitude" BETWEEN ${box.minLng} AND ${box.maxLng}`;
      const colourFilter = q.colourMode
        ? Prisma.sql`AND EXISTS (SELECT 1 FROM "PricingRule" r WHERE r."shopId" = s."id" AND r."active" = true AND r."colourMode"::text = ${q.colourMode})`
        : Prisma.empty;
      const rows = await db.$queryRaw<Array<{ id: string; distance_km: number; total: bigint }>>`
        SELECT id, distance_km, count(*) OVER () AS total FROM (
          SELECT s."id" AS id,
                 2 * ${EARTH_RADIUS_KM} * asin(sqrt(least(1.0,
                   power(sin(radians(s."latitude" - ${q.lat}) / 2), 2) +
                   cos(radians(${q.lat})) * cos(radians(s."latitude")) * power(sin(radians(s."longitude" - ${q.lng}) / 2), 2)
                 ))) AS distance_km
          FROM "Shop" s
          WHERE s."isVerified" = true AND s."status" = 'ACTIVE'
            AND s."latitude" IS NOT NULL AND s."longitude" IS NOT NULL
            AND s."latitude" BETWEEN ${box.minLat} AND ${box.maxLat}
            ${lngFilter}
            ${colourFilter}
        ) d
        WHERE distance_km <= ${q.radiusKm}
        ORDER BY distance_km ASC, id ASC
        LIMIT ${q.limit} OFFSET ${q.offset}`;
      // total is 0 when the page is beyond the last row: recount so clients still get an honest total.
      let total = rows[0] ? Number(rows[0].total) : 0;
      if (rows.length === 0 && q.offset > 0) {
        const c = await db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM "Shop" s
          WHERE s."isVerified" = true AND s."status" = 'ACTIVE' AND s."latitude" IS NOT NULL AND s."longitude" IS NOT NULL
            AND s."latitude" BETWEEN ${box.minLat} AND ${box.maxLat}
            ${lngFilter}
            ${colourFilter}
            AND 2 * ${EARTH_RADIUS_KM} * asin(sqrt(least(1.0,
              power(sin(radians(s."latitude" - ${q.lat}) / 2), 2) +
              cos(radians(${q.lat})) * cos(radians(s."latitude")) * power(sin(radians(s."longitude" - ${q.lng}) / 2), 2)))) <= ${q.radiusKm}`;
        total = Number(c[0]?.n ?? 0);
      }
      return { rows: rows.map((r) => ({ id: r.id, distanceKm: Math.round(Number(r.distance_km) * 10) / 10 })), total };
    }
  };
}

/** True when the PostGIS extension is installed in the connected database. */
export async function postgisInstalled(db: Db): Promise<boolean> {
  const r = await db.$queryRaw<Array<{ ok: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS ok`;
  return r[0]?.ok === true;
}

/**
 * PostGIS implementation (ST_DWithin on a geography built from the stored latitude/longitude). The expression matches the optional
 * GiST index created by prisma/postgis/enable.sql, so the index is used when it exists and the query still works without it.
 * Distances are geodesic (spheroid); the haversine fallback is spherical, so the two differ by well under 1%.
 */
export function postgisRepository(db: Db): ShopGeoRepository {
  return {
    async nearby(q) {
      const colourFilter = q.colourMode
        ? Prisma.sql`AND EXISTS (SELECT 1 FROM "PricingRule" r WHERE r."shopId" = s."id" AND r."active" = true AND r."colourMode"::text = ${q.colourMode})`
        : Prisma.empty;
      const meters = q.radiusKm * 1000;
      const rows = await db.$queryRaw<Array<{ id: string; distance_m: number; total: bigint }>>`
        SELECT s."id" AS id,
               ST_Distance(ST_SetSRID(ST_MakePoint(s."longitude", s."latitude"), 4326)::geography, ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography) AS distance_m,
               count(*) OVER () AS total
        FROM "Shop" s
        WHERE s."isVerified" = true AND s."status" = 'ACTIVE' AND s."latitude" IS NOT NULL
          AND ST_DWithin(ST_SetSRID(ST_MakePoint(s."longitude", s."latitude"), 4326)::geography, ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography, ${meters})
          ${colourFilter}
        ORDER BY distance_m ASC, s."id" ASC
        LIMIT ${q.limit} OFFSET ${q.offset}`;
      let total = rows[0] ? Number(rows[0].total) : 0;
      if (rows.length === 0 && q.offset > 0) {
        const c = await db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM "Shop" s
          WHERE s."isVerified" = true AND s."status" = 'ACTIVE' AND s."latitude" IS NOT NULL
            AND ST_DWithin(ST_SetSRID(ST_MakePoint(s."longitude", s."latitude"), 4326)::geography, ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography, ${meters})
            ${colourFilter}`;
        total = Number(c[0]?.n ?? 0);
      }
      return { rows: rows.map((r) => ({ id: r.id, distanceKm: Math.round((Number(r.distance_m) / 1000) * 10) / 10 })), total };
    }
  };
}

/**
 * Chooses the backend. 'postgis' is used only when the extension is actually installed (checked once, lazily); otherwise the portable
 * implementation answers, so enabling the flag on a database without PostGIS can never break discovery.
 */
export function selectGeoRepository(db: Db, backend: 'haversine' | 'postgis', onFallback?: () => void): ShopGeoRepository {
  const portable = haversineRepository(db);
  if (backend !== 'postgis') return portable;
  const spatial = postgisRepository(db);
  let resolved: Promise<ShopGeoRepository> | null = null;
  return {
    async nearby(q) {
      resolved ??= postgisInstalled(db).then((ok) => {
        if (!ok) onFallback?.();
        return ok ? spatial : portable;
      }, () => {
        onFallback?.();
        return portable;
      });
      return (await resolved).nearby(q);
    }
  };
}
