# Printout Buddy: architecture and Android API handoff

Documentation-only deliverable for the Android developer. It describes the **existing, production backend on `origin/main`** (commit `080c6bd`, 2026-10) so the app can be integrated without reading the repository. No application code, schema, migration, deployment or production setting was changed to produce it.

- Production: `https://printoutbuddy.tech` (API prefix `/api/v1`)
- Repository: `singhdaksh7/printout-`
- Combined handoff PDF: [`printout-buddy-android-handoff.pdf`](./printout-buddy-android-handoff.pdf) (same content as the files below, in one document)
- OpenAPI 3.0.3 spec: [`../openapi/api-v1.yaml`](../openapi/api-v1.yaml) (113 operations)

## Start here (Android)

1. [android-integration-guide.md](./android-integration-guide.md): auth, token handling, Kotlin examples, FCM, errors, offline.
2. [sequence-diagrams.md](./sequence-diagrams.md): flows A-G (onboarding, sign-in, refresh, upload/order, printing, retention, pricing).
3. [api-inventory.md](./api-inventory.md): every route with auth, schemas, errors, idempotency, rate limits.
4. [api-entity-map.md](./api-entity-map.md): endpoint ↔ tables read/written, and whether Android should use it.

## Document index

| File | Contents |
|---|---|
| [full-er-diagram.md](./full-er-diagram.md) | All 32 models, enums, non-FK references |
| [er-auth.md](./er-auth.md) | User, identities, sessions, refresh tokens, onboarding grants |
| [er-shop-pricing.md](./er-shop-pricing.md) | Shop, settings, hours, pricing rules |
| [er-orders-documents.md](./er-orders-documents.md) | Orders, documents, lifecycles, retention fields |
| [er-devices-printers.md](./er-devices-printers.md) | Devices, pairing, printers, print-job state machine |
| [er-notifications.md](./er-notifications.md) | Inbox/outbox, FCM registrations, SSE |
| [er-admin-security.md](./er-admin-security.md) | Admin 2FA, login challenges, audit log |
| [er-legacy-billing.md](./er-legacy-billing.md) | Plans, subscriptions, invoices, payments (platform is free) |
| [system-architecture.md](./system-architecture.md) | Component and flow diagrams |
| [sequence-diagrams.md](./sequence-diagrams.md) | Sequence diagrams A-G |
| [api-inventory.md](./api-inventory.md) / [api-entity-map.md](./api-entity-map.md) | API catalog and DB mapping |
| [android-integration-guide.md](./android-integration-guide.md) | Kotlin integration guide |

## Headline numbers

| | |
|---|---|
| Prisma models | **32** (24 in active use, 8 schema-only target tables) |
| Prisma enums | 14 |
| Registered routes | **113** (111 under `/api/v1` + `/health` + `/ready`) |
| Deprecated (retired, answers 410) | 1 (`POST /shop/orders/:id/print-confirmation`) |
| Routes by area | Auth/onboarding 19, Profile 5, Settings 10, Pricing/quotes 5, Orders 11, Printing/devices 24, Notifications 6, Analytics 3, Customer public 6, Admin 21, Ops 3 (see inventory for the exact list) |
| Mermaid diagrams | **26** (9 ER, 3 state, 7 flowcharts, 7 sequence), all rendered without errors (see [validation](#how-this-was-verified)) |

## What is on `main` vs not

| Item | Status |
|---|---|
| Web app, API, worker, Windows agent, mobile auth/profile/FCM APIs | **On `main`** |
| Phase A: live queue filters (`print=`, `sort`, `/shop/orders/counts`), customer tracking (`printIssue`, `serverTime`), privacy hardening | **On `main`** (PR #41) |
| Google sign-up + new-shop onboarding (web PR #39), free platform with immediate `ACTIVE` shop (PR #40) | **On `main`** |
| Phase B (`feature/daksh-phase-b-smart-print-printers`) | **Not on `main`.** The branch has **zero commits** beyond `main` at the time of writing, so nothing Phase-B-specific exists to document. |
| Android app source (`feature/daksh-android-companion`, `phase3/android*`, 21 commits ahead, `apps/android`) | **Not on `main`** |
| Other unmerged branches (`development`, `feature/daksh-firebase-profile-api`, `feature/daksh-release-coordinator`, `feature/resend-email-system`) | **No route exists on any of them that is absent from `main`** (checked by extracting the registered routes of each branch and diffing: `main` is a superset). |

## How this was verified

1. **Routes (two independent checks):** (a) a static scan of every `*.ts` under `apps/api/src` for `app|scope.<verb>('<path>')` registrations (multi-line aware) found **113**; (b) the real application was instantiated from the TypeScript source (`createApp` in `src/app.ts` via `tsx`, dummy config, **no database or network**) and every route was collected through a Fastify `onRoute` hook: **111** routes under `/api/v1` plus `/health` and `/ready` (registered directly on the root) = **113**, with identical method+path sets. The documentation table, the API inventory, the entity map and the OpenAPI spec are all generated from **one** route table, and generation aborts if that table's method+path set differs from the scan (113 = 113, no missing, no extra, no duplicates). The throwaway scripts are not committed (this change is documentation only). Note: the checked-in `apps/api/dist` build is **stale** (110 routes, built before Phase A) and was deliberately not used.
2. **Schemas and errors:** transcribed from the route handlers, their zod schemas and the domain functions they call (request bodies, query strings, response objects, `AppError` codes). The spec was **not** inferred from tests or older docs.
3. **Prisma:** the ER diagrams were written from `schema.prisma`: 32 `model` blocks, 14 `enum` blocks, all relations, uniques and `onDelete` rules. 8 models were confirmed unused by searching the application source for any Prisma access to them.
4. **Mermaid:** every ` ```mermaid ` block was parsed and rendered with `mermaid@11.4.1` in headless Chromium (the same pipeline produced the PDF); the check fails on any syntax error.
5. **OpenAPI:** validated with `@apidevtools/swagger-parser` (OpenAPI 3.0.3: 100 paths, 113 operations, 21 component schemas, all `$ref`s resolved).
6. **Secrets:** no tokens, keys, passwords or production values appear in these files; examples use placeholders. Only `deploy/env.production.example` *key names* were consulted, never values.

## Findings: missing, ambiguous or stale contracts

| # | Finding | Impact / recommendation |
|---|---|---|
| 1 | **Docs vs code on new-shop status.** `docs/MOBILE_AUTH_API.md`, `docs/API_CONTRACT.md` and `docs/FIREBASE_PHONE_LOGIN.md` say self-onboarded shops are `PILOT`, `acceptsOrders=false`, awaiting admin activation. The code (since PR #40) creates them **`ACTIVE`, `acceptsOrders=true`, no subscription**. | Android should trust the response (`shopStatus`, `nextStep`), not those docs. Recommend fixing the old docs (not done here: docs-only scope of *new* files). |
| 2 | **Production feature flags unknown.** `GOOGLE_LOGIN_ENABLED`, `SHOP_SELF_ONBOARDING_ENABLED`, `FCM_PUSH_ENABLED` default to `false` in code; production values, `FIREBASE_PROJECT_ID`, `STORAGE_DRIVER`, `RATE_LIMIT_*` overrides and token TTL overrides are not in the repo. | **Requires confirmation** with whoever operates the server. The app must handle `503 GOOGLE_LOGIN_UNAVAILABLE`, `403 SELF_ONBOARDING_DISABLED` and absent push. Read TTLs from `expiresIn` / `refreshTokenExpiresIn`. |
| 3 | **Lost refresh response is unrecoverable.** Refresh rotates the token server-side before the reply arrives; a lost reply leaves the app holding a spent token (reuse → family revoked). | Documented in the guide: generous timeout, treat as signed-out. A server-side idempotent refresh would be a backend change (out of scope). |
| 4 | **Firebase token freshness.** `POST /auth` needs a Firebase ID token whose `auth_time` is ≤ 300 s old and strictly newer than the last accepted one. `getIdToken(true)` does not help. | The app must perform a real Google sign-in right before each exchange (documented). |
| 5 | Response shapes not pinned by a schema in code: `GET /shop/analytics/revenue` (`totals`, `daily`, `breakdown`, `comparison`), `GET /shop/hours` (`availability`), `GET /public/shops/:slug`, all admin responses. | Marked `any`/partial in the spec and **Requires confirmation** before hard-typing. |
| 6 | Whether the owner app should also pair as a **device** (`/device/*`) is a product decision. Owner-session Bearer is the documented path; device mode exists for a companion Android device. | **Requires confirmation.** |
| 7 | Several updates use `PUT` with **partial** bodies (`/shop/settings`, `/shop/hours`, `/shop/pricing-rules/:id`) and have no version/ETag (last write wins). | Documented; do not send the whole object expecting replace semantics. |
| 8 | `POST /public/shops/:slug/orders` returns **200** (not 201) both for a new order and for an idempotent replay. | Do not use the status code to tell them apart. |
| 9 | Realtime is best-effort: SSE bus is in memory on one API process; worker events never reach it. Customers have no push. | Use FCM + `GET /shop/notifications?after=` + polling as recovery. |
| 10 | CORS allows only `content-type`, `x-csrf-token`, `last-event-id` request headers (browser-only concern; native apps ignore CORS). | Irrelevant to OkHttp; matters only if a WebView calls the API. |
| 11 | `docs/openapi/current.yaml` is a path-only subset (86 paths in the older file) with no schemas. | Superseded for integration by `docs/openapi/api-v1.yaml`; the old file was left untouched. |
| 12 | An existing owner who never linked Google and signs in with Google gets the **restricted** pair even with a matching email; onboarding then fails with `409 EMAIL_UNAVAILABLE`. | Documented flow: sign in by the existing method, then link Google. |
| 13 | `ShopStatus` values `PILOT`, `PAST_DUE`, `CANCELLED` are never set by application code (an admin can set them); `Membership` is unused for authorization. | Treat unknown/other statuses as "not live" (`isActive=false`). |

## Conventions

- **Status labels** on each endpoint: *Verified from code* (all 112 active routes), *Deprecated* (1), *Not implemented* (listed in the inventory's own section, **not** as routes), *Requires confirmation* (called out inline where production config or an inner shape decides the behaviour).
- Paths are shown with the `/api/v1` prefix except `/health` and `/ready`.
- Never commit production secrets into these documents.
