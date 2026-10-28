# PostGIS runbook (decision D4)

Status: **the application ships without a PostGIS dependency.** Nearby search runs on the portable haversine repository (`GEO_BACKEND=haversine`, default). PostGIS is an optional accelerator, enabled by an operator only after every check below passes. `GEO_BACKEND=postgis` falls back to haversine automatically if the extension is not installed, so the flag can never break discovery.

## What was verified (disposable `postgis/postgis:16-3.4`, PostGIS 3.4.3)

- All repository migrations apply; `prisma migrate diff` reports no drift with the GiST index present (the index is an expression index that Prisma ignores).
- `apps/api/test/schema-v2-postgis.test.ts` (7 tests, runs only with `POSTGIS_TEST_DATABASE_URL`): identical shops, order and totals vs the haversine repository at 1/5/20 km (distances within 0.2 km), unverified shops never returned, pagination totals, automatic fallback when the extension is absent.
- `prisma/postgis/enable.sql` is idempotent (`CREATE EXTENSION IF NOT EXISTS`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`).

## Production pre-flight (read-only; all must pass)

1. `SELECT version();` and `SHOW server_version;` - supported major version.
2. `SELECT name, default_version FROM pg_available_extensions WHERE name = 'postgis';` - the package is installed on the server. If no row: **stop**, PostGIS is not available; keep `GEO_BACKEND=haversine` and report PostGIS pending.
3. `SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user;` and, for managed databases, whether the provider allows `CREATE EXTENSION postgis` for the application role (often a dashboard toggle). If privileges are missing, **stop**.
4. A fresh backup exists, a restore of it has been tested on a disposable database, and an independent off-server copy exists.
5. Row count of `Shop` (small) and current query latency baseline for `GET /customer/shops/nearby` on a copy.
6. Maintenance risk: `CREATE EXTENSION` takes a brief catalogue lock; `CREATE INDEX CONCURRENTLY` does not block writes.

## Enable (only after the pre-flight passes)

```
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
psql "$DATABASE_URL" -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "Shop_location_gist" ON "Shop" USING gist ((ST_SetSRID(ST_MakePoint("longitude","latitude"),4326)::geography)) WHERE "latitude" IS NOT NULL;'
```

Then set `GEO_BACKEND=postgis`, restart the API, and run the nearby smoke test (same shop ids and order as before). Verify with `EXPLAIN` that the GiST index is used once the table has meaningful size.

## Rollback

Set `GEO_BACKEND=haversine` and restart (immediate, no data change). The extension and index can stay; dropping them (`DROP INDEX "Shop_location_gist"`) is optional and separate.
