# Printout

Mobile-web SaaS for neighbourhood print shops (₹99/month/shop). A shop displays a permanent QR code; customers scan it,
upload one document, configure the print, get a server-authoritative quote, submit, and track the order. No customer accounts.
Customer documents are temporary: deleted 30 minutes after the shop confirms printing (unprinted uploads expire after 24 hours).

Source of truth: `docs/MASTER_SPEC.md` (frozen decisions) and `docs/API_CONTRACT.md` (implemented API).

## Layout

```
apps/api         Fastify + Prisma modular monolith (API, cleanup worker, migrations, seed)
apps/web         React + Vite PWA: customer (/p/:slug, /t/:token), shop (/shop), platform admin (/admin)
e2e              Playwright browser tests
deploy           Production compose, Caddyfile, backup/restore/deploy scripts
docs             Spec, API contract, security review, deployment guide
```

## Run locally

Requires Node 22+, Docker. PostgreSQL is mapped to host port **55433** (to avoid clashing with other local databases).

```bash
corepack pnpm install
cp .env.example .env            # local-only values; set long SESSION_SECRET / CSRF_SECRET
corepack pnpm db:up             # docker compose up -d postgres
corepack pnpm db:generate
corepack pnpm db:migrate        # prisma migrate deploy (checked-in migrations only)
corepack pnpm db:seed           # two demo shops, a platform admin, the ₹99 plan
corepack pnpm dev               # API :3000, cleanup worker, web :5173 (proxies /api)
```

Demo logins (password `change-this-development-password` unless `SEED_PASSWORD` is set):
`owner@central.test` (shop `central-print`), `owner@metro.test` (`metro-copies`), `admin@printout.test` (platform admin).
Customer URL: <http://localhost:5173/p/central-print>. Shop: <http://localhost:5173/shop>. Admin: <http://localhost:5173/admin>.

Uploads use local private storage by default (`STORAGE_DRIVER=local`, `LOCAL_UPLOAD_DIR`). For S3/R2 set `STORAGE_DRIVER=s3` and the `S3_*` keys;
`docker compose --profile s3 up -d minio` provides a local S3-compatible store.

## Test

```bash
corepack pnpm check             # TypeScript, all workspaces
corepack pnpm test              # api (real PostgreSQL `printout_test`) + web unit tests
corepack pnpm build
corepack pnpm e2e               # Playwright; uses its own `printout_e2e` database, ports 3100/5273
```

API tests need the `printout_test` database: `docker exec print-codex-postgres-1 psql -U printout -c "CREATE DATABASE printout_test"`.
They truncate it, so never point `TEST_DATABASE_URL` elsewhere, and do not run two API test runs against the same database at once.

## Production

See `docs/DEPLOYMENT.md` (single VPS, Docker, Caddy HTTPS, PostgreSQL, private R2/S3). Nothing is deployed from this repository automatically.
Security findings and accepted risks: `docs/SECURITY_REVIEW.md`.

## Principles

- One shared, tenant-isolated platform; tenant identity comes only from the authenticated session.
- The API owns authorization, pricing, document lifecycle and status transitions; the UI only displays server values.
- Documents are private, temporary objects and never live in PostgreSQL. Database changes use reviewed migrations, never `db push`.
- Out of V1: online payments, billing automation, customer accounts, staff roles, Print Agent / printer integrations.
