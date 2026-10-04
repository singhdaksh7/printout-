# Orchestration brief (build phase)

Source of truth: `docs/MASTER_SPEC.md` + `docs/API_CONTRACT.md` (frozen semantics: A4-only, per-physical-sheet duplex pricing,
30-min print retention that is never extended, 24h unprinted expiry, no customer accounts/phone, one doc per order, backend-authoritative price,
tenant from session only). Do not change those semantics.

## Environment (already running)
- Repo root: `C:\Users\daksh\OneDrive\Desktop\Print\Print-codex` (git worktree, branch `agent/backend`). Windows; Git Bash + PowerShell. Use `corepack pnpm ...`.
- PostgreSQL 16 in docker: `print-codex-postgres-1`, host port **55433**. DBs: `printout` (dev), `printout_test` (tests only).
  Dev `.env` exists at repo root (`DATABASE_URL=postgresql://printout:change-me@localhost:55433/printout`). Load it in a shell with `set -a; . ../../.env; set +a`.
- API tests: `cd apps/api && corepack pnpm test` (vitest; globalSetup runs `prisma migrate deploy` on `printout_test`; use `test/helpers/db.ts` `resetDb()`; files run serially).
- Web: `apps/web` is scaffolded (Vite 6 + React 18 + react-router 6 + vitest 3 + vite-plugin-pwa). `corepack pnpm check|build|test` work. Vite proxies `/api` → `localhost:3000`.
- NEVER: git commit/push/reset/clean/stash/checkout; `prisma db push`; `prisma migrate reset` on any non-test DB; touch other docker containers (other projects run on this machine on ports 5432-5434, 55432, 3306 — leave them alone).
- Other agents are editing the repo **at the same time**. Edit ONLY files you own. If you need a change in a file you don't own, make the smallest possible edit ONLY if it is a one-line import/registration, otherwise describe it in your final report. Don't run repo-wide formatters. Installing deps: `corepack pnpm --filter <pkg> add <dep>` (fine to run concurrently; don't hand-edit pnpm-lock.yaml).
- Do not leave dev servers running when you finish. Do not write secrets into the repo.

## Ownership
| Agent | Owns (exclusive write) |
| --- | --- |
| BE (backend/API) | `apps/api/src/app.ts` and new `apps/api/src/routes/**`, `src/auth.ts`, `src/config.ts`, `src/errors.ts`, `src/events.ts`, `src/server.ts`, `src/domain/**`, `prisma/schema.prisma`, `prisma/migrations/**`, `prisma/seed.ts`, `test/api-*.test.ts`, `test/domain*.test.ts`, `docs/API_CONTRACT.md`, `.env.example` |
| FILES (uploads/PDF/storage) | `apps/api/src/storage/**` (replaces `src/storage.ts` — keep `src/storage.ts` as a re-export shim so imports keep compiling), `src/pdf/**`, `src/uploads.ts` (+ `src/internal-storage.ts` for the local signed-URL file routes), `test/storage-*.test.ts`, `test/uploads-*.test.ts`, `test/fixtures/**` |
| RET (retention/worker/DB) | `apps/api/src/cleanup.ts`, `src/worker.ts`, `test/retention-*.test.ts`, `test/worker-*.test.ts`, `test/helpers/**` (extend, don't break `resetDb`) |
| WEB-C (customer PWA) | `apps/web/src/customer/**` (and `apps/web/src/lib/customer-*.ts`) |
| WEB-S (shop app) | `apps/web/src/shop/**` (and `apps/web/src/lib/shop-*.ts`) |
| Lead | `apps/web/src/{App,main}.tsx`, `src/lib/api.ts`, `src/lib/format.ts`, `styles.css`, root configs, docker/compose, README |
| later waves | ADMIN: `apps/web/src/admin/**` + `src/routes/admin*.ts`; SEC: anywhere (fix verified issues); E2E: `e2e/**`; DEVOPS: `deploy/**`, Dockerfiles, compose |

## Backend ↔ Files interface (agreed now so both sides can work in parallel)
```ts
// apps/api/src/storage/index.ts (FILES owns; BE only calls it)
interface Storage {
  // Streams `body` into private storage under a server-generated random key. Never buffers whole file. Enforces maxBytes while streaming.
  put(key: string, body: NodeJS.ReadableStream, opts: { maxBytes: number; contentType?: string }): Promise<{ size: number; sha256: string }>;
  head(key: string): Promise<{ size: number } | null>;          // null if missing
  openRead(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream>; // server-side read (PDF inspection)
  // Short-lived URL for the browser. local: HMAC-signed `/api/v1/internal/documents/<key>?exp=..&sig=..` (re-checks DB retention when served).
  // s3: presigned GET. `expiresSeconds` MUST be honoured as an upper bound; callers cap it at the retention deadline.
  temporaryReadUrl(key: string, expiresSeconds: number, opts?: { contentType?: string; filename?: string }): Promise<{ url: string; expiresAt: Date }>;
  delete(key: string): Promise<void>;                            // idempotent: missing object = success
  exists(key: string): Promise<boolean>;
}
createStorage(config): Storage   // STORAGE_DRIVER=local|s3
```
Upload flow (public, no auth, rate-limited), response shapes stay as documented in `API_CONTRACT.md` and as currently returned by `app.ts`:
1. `POST /api/v1/public/shops/:slug/uploads/initiate` → `{uploadId, uploadUrl, requiredHeaders, expiresAt, limits}`; `uploadUrl` is a same-origin relative path (local driver: `PUT /api/v1/public/uploads/:uploadId/content?token=...` streamed, single-use, size-capped) or an absolute presigned PUT (s3 driver). The browser `PUT`s the raw file to `uploadUrl` with `requiredHeaders`.
2. `POST .../uploads/:uploadId/complete` → server re-reads the object, validates magic bytes (never trusts extension/declared MIME), counts PDF pages (rejects encrypted/corrupt/>maxPdfPages), then sets `AVAILABLE`, `uploadedAt`, `expiresAt = uploadedAt + 24h`, `pageCount`, `checksum`. On rejection the object is deleted and the Document is marked `FAILED`.
BE registers FILES' plugin with one line: `app.register(uploadRoutes, { prefix: '/api/v1', prisma, storage, config })` and `app.register(internalStorageRoutes, { prefix: '/api/v1', prisma, storage, config })` imported from `./uploads.js` / `./internal-storage.js`. Until FILES delivers, BE leaves the existing inline upload endpoints in place (and removes them in the same edit that registers the plugin once the files exist).
Document access (BE owns the route `POST /shop/orders/:id/document-access`): must (a) require shop session+CSRF+tenant match, (b) deny if `status==='DELETED'` OR `deleteAfter <= now` OR `expiresAt <= now` for unprinted docs, (c) call `storage.temporaryReadUrl(key, min(300, secondsUntilDeleteAfter))`. The local internal-document route (FILES) must re-check the same conditions against the DB at fetch time and require the HMAC signature.

## Error codes (BE owns `src/errors.ts`; FILES/RET import from it, BE creates it first)
`AppError(status, code, message, details?)` with codes: INVALID_FILE_TYPE FILE_TOO_LARGE EMPTY_FILE PDF_TOO_MANY_PAGES INVALID_PDF PASSWORD_PROTECTED_PDF INVALID_PAGE_RANGE ORDER_NOT_FOUND DOCUMENT_UNAVAILABLE INVALID_STATUS_TRANSITION UNAUTHORIZED FORBIDDEN CSRF_INVALID RATE_LIMITED VALIDATION_ERROR NOT_FOUND INVALID_QUOTE QUOTE_EXPIRED NO_PRICING_RULE SHOP_UNAVAILABLE. Envelope: `{ error: { code, message, requestId, details? } }`. No stack traces in responses.

## Frontend ↔ API
Frontends code against `API_CONTRACT.md` + the response shapes currently in `apps/api/src/app.ts` (BE keeps changes additive and documents them in `API_CONTRACT.md`). Use `src/lib/api.ts` (`api()`, `setCsrfToken`). Cookie auth is same-origin via the Vite proxy; mutations send `x-csrf-token` (from `/auth/login` or `/auth/session` response `csrfToken`). Test with vitest + mocked `fetch`; do not put pricing/transition/retention policy in UI code (display only what the server returns; countdowns use server `deleteAfter`).
Public routes: `/p/:slug` (customer flow), `/t/:trackingToken` (tracking). Shop: `/shop/login`, `/shop` (queue), `/shop/orders/:id`, `/shop/pricing`, `/shop/qr`, `/shop/analytics`, `/shop/settings`. Admin: `/admin/*`.
