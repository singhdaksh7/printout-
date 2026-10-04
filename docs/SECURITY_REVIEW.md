# Security review log (SEC agent)

Scope: `apps/api` (all routes, auth, uploads, storage, PDF inspection, retention worker, SSE), skim of `apps/web`.
Method: read all source, adversarial probing, failing test first for each verified issue (`apps/api/test/security-hardening.test.ts`).
Run against a private DB (`printout_test_sec`).

## Fixed

| # | Sev | Finding | Evidence / fix |
| - | --- | --- | --- |
| 1 | High | Request logger printed the full URL, including query strings: signed document URLs (`sig`), upload tokens (`token`), and the path-borne tracking token / storage key. Anyone with log access could fetch documents or hijack uploads/orders within the token lifetime. | Test captures pino output. Fix: custom `req` serializer (`safeRequestUrl` in `app.ts`) drops the query and masks `/public/orders/:token` and `/internal/documents/:key`. |
| 2 | Medium | Order total overflow: `copies(1000) x 200 pages x 1,000,000 paise` exceeds the 32-bit `totalPaise` column, so quote succeeded and order creation 500'd. | Test: quote returned 200. Fix: `quote()` rejects totals above 2,000,000,000 paise with 422 `VALIDATION_ERROR`. |
| 3 | Medium | Login throttle keyed by `ip|email`; with `TRUST_PROXY=true` and a proxy that appends to X-Forwarded-For, a client rotating a forged XFF got unlimited password guesses. | Test: 20 rotating-IP failures then correct password -> 200. Fix: additional account-wide failure budget (4x `LOGIN_FAIL_MAX`) independent of IP; new `TRUST_PROXY_CIDRS` (Fastify 5 ignores numeric hop counts) so only listed proxies are trusted. Deploy note: Caddy replaces XFF, so the shipped compose is not exposed, but prefer `TRUST_PROXY_CIDRS`. |
| 4 | Medium | Raw upload `PUT` accepted `application/json` / `text/plain`, which Fastify buffers and JSON-parses in memory up to `UPLOAD_MAX_BYTES` (50 MB) per request; any anonymous caller holding an upload token could amplify memory/CPU. | Test: 2 MB JSON got to the handler (422). Fix: `onRequest` guard returns 415 `INVALID_FILE_TYPE` unless content-type is an accepted MIME, `application/octet-stream` or absent. |
| 5 | Medium | `requestTimeout` was 0 (disabled by Fastify), so slow-body (slowloris) clients could hold sockets indefinitely. | Test asserts `server.requestTimeout > 0`. Fix: 15 minutes (= upload token TTL). |
| 6 | Low | Document ids were cuid v1 (timestamp + counter + ~41 random bits) yet act as the capability for quote/order/complete of an anonymous upload. | Fix: 144-bit random id generated at upload initiation. |
| 7 | Low | API JSON (tokens, order data, document URLs) had no `Cache-Control`. | Fix: global `onSend` hook sets `no-store` when a route did not set its own. |

## Verified OK (probed, no change needed)

- Tenant isolation: every shop route filters by session `shopId` (`findFirst({id, shopId})`, `updateMany`/`deleteMany` with `shopId`); foreign ids return 404; client `shopId` is rejected by `.strict()` schemas; no request body is spread into Prisma `data` without a strict schema.
- Admin guard: owners get 403 on `/admin/*`, admins get 403 on `/shop/*`; admin responses never contain document data.
- SSE: per-shop sinks and ring buffers, replay only from the caller's shop buffer, session and shop status re-checked on heartbeat.
- Sessions: 256-bit random token stored as SHA-256, rotated on login, invalidated on logout/suspension, HttpOnly + Secure(prod) + SameSite + Path=/api/v1; CSRF HMAC bound to session id on all mutations including logout and admin; GET routes have no side effects; CORS is a single configured origin.
- Quotes: HMAC-signed with expiry and shop binding, carry no price; order recomputes with current rules and the document's real page count; idempotent per `clientRequestId`.
- Tracking tokens: 256-bit, constant 404 for unknown/malformed, rate limited.
- Uploads: server-generated random keys (never from filename), strict key regex plus `path.dirname` check, magic-byte detection, PNG/JPEG dimension caps, PDF parsed in a worker thread with heap limit and timeout, single-use token (atomic `link`), size enforced while streaming.
- Document delivery: HMAC URL plus DB re-check of status/`deleteAfter`/`expiresAt` per request; `nosniff`, `no-store`, restrictive CSP, sanitized `Content-Disposition`.
- Retention: conditional `updateMany` guards (print-confirmation vs worker cannot both win), print confirmation re-checks `expiresAt`, timestamps immutable on repeat confirmation, worker only touches keys from its own DB row.
- Error handler: 5xx are generic in production (tested with a P2021-style error); no stack/Prisma text in responses.
- Config: production refuses placeholder secrets, identical session/CSRF secrets, default DB password, non-https origin.
- Web: no `dangerouslySetInnerHTML` with API data (only locally generated QR SVG), external links use `rel="noopener noreferrer"`, preview iframe is sandboxed without scripts, only a recent-orders list (tracking tokens, by design) is in localStorage. No web changes made.

## Accepted / remaining risks

- `pnpm audit --prod`: `deepmerge-ts <8` (via Prisma CLI config, build/migrate-time only, not reachable from requests); `react-router <7.18` open-redirect/SSR advisories (the app uses client-side routing only; redirect targets come from router state and are prefix-checked). Upgrade when Prisma/React Router majors are adopted.
- A document URL issued by `document-access` stays valid up to 5 minutes (bounded by the retention deadline) even if the order is cancelled meanwhile.
- Upload PUT storage failure path deletes the object before checking for `KEY_EXISTS`; in a multi-process deployment two simultaneous PUTs with the same single-use token could discard the winner's file (self-inflicted by the token holder; no cross-tenant impact).
- Concurrent `/complete` calls each parse the PDF in a worker (up to 768 MB heap); bounded only by the per-IP rate limit (60/min). Consider a global concurrency cap.
- Authenticated shop routes are not rate limited; SSE connections per session are unbounded.
- Admin shop search combined with a cursor drops the search filter (`OR` key collision in `admin.ts`): functional, not a security issue; reported to ADMIN/lead.
- The in-memory login throttle and SSE bus are per process (documented limitation).
