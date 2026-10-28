-- Optional PostGIS acceleration for customer nearby search (schema-v2 decision D4).
-- NOT a Prisma migration: the Prisma schema does not depend on PostGIS and nearby search works without it (GEO_BACKEND=haversine).
-- Run manually, per docs/schema-v2/POSTGIS_RUNBOOK.md, only after the pre-flight checks pass. Idempotent; safe to re-run.
-- Run each statement as a separate psql call (CREATE INDEX CONCURRENTLY cannot run inside a transaction).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Shop_location_gist"
  ON "Shop" USING gist ((ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography))
  WHERE "latitude" IS NOT NULL;
