# Schema V2 implementation progress

Status values: NOT_STARTED, IN_PROGRESS, IMPLEMENTED, TESTED, MERGED, DEPLOYED (only with verified production evidence), BLOCKED. Resume rule: a new session reads this file, `02-architecture-decisions.md` and the architecture skill, then continues at the first row that is not MERGED/DEPLOYED.

## Production deployment record

| Release | Evidence |
|---|---|
| Phases 1-4 DEPLOYED 2026-10-28 ~09:45 UTC to the production VPS (api + worker; web unchanged) | main merge `52b6a0b` (PR #54), tag `release-20261028-schemav2-p1-4`; 6 additive migrations `20261028100000`..`20261028130100` applied (18 total, 0 failed); `/health` 200, `/ready` ready, read-only smoke 10/10 (`retentionMinutes=30` confirmed); new routes answer 401 unauthenticated; row counts unchanged (16 shops, 12 users, 27 orders, 44 documents); no error logs. Flags OFF: `CUSTOMER_SIGNUP_ENABLED`, `ORDER_REJECT_ENABLED`; `GEO_BACKEND=haversine`. Rollback images `printout-{api,web}:rollback-pre-schemav2-20261028`. Backups before deploy (age-encrypted, copied off-server to the operator laptop with matching sha256): `printout-20261028T092927Z`, `printout-20261028T093929Z`; restore rehearsal and migration rehearsal passed on a restored copy before deploying. NOTE: the scheduled backup job still has no off-server remote (`BACKUP_RCLONE_REMOTE` unset); off-server copies are manual until a remote is configured. |

## Production deployment record 2

| Release | Evidence |
|---|---|
| Phase 5 + customer web app (flag OFF) DEPLOYED 2026-10-28 ~11:55 UTC (api, worker, web) | main merge `46f2322` (PR #58), tag `release-20261028-schemav2-p5-web`; migration `20261028140000_reviews_customer_notifications` applied (0 failed); health/ready OK, read-only smoke 10/10; `/customer/notifications` answers 401 (live); `/app` not served (VITE_MARKETPLACE unset, default bundle has no marketplace code); row counts unchanged (16 shops, 12 users, 27 orders); rollback images `printout-{api,web}:rollback-pre-p5-20261028`; pre-deploy backup `printout-20261028T115103Z` copied off-server (laptop) with matching sha256. |

## Repository state

| Step | Status | Evidence |
|---|---|---|
| Docs PR #45 | MERGED | `62d60b0` |
| Skill PR #46 | MERGED | `647d45a` |
| Decisions recorded APPROVED | IN_PROGRESS | branch `docs/schema-v2-approvals` |
| development/main sync (PR #47) | IN_PROGRESS | candidate tree identical to main |

## Phase 1 - Identity and multi-shop (DEPLOYED, flags off)

| Requirement | Status | Evidence |
|---|---|---|
| Customer role, role grants, nullable email, customer profile, `GET /shops/mine`, customer sign-in (audience), onboarding (flag off) | DEPLOYED | PR #49, squash `2b17805`; 23 tests + full suite 58 files |

## Phase 2 - Discovery (DEPLOYED; haversine backend, PostGIS not enabled)

| Requirement | Status | Evidence |
|---|---|---|
| Shop address, coordinates, verification columns; paper options; photos (migration `20261028110000`) | TESTED | disposable PG16 upgrade with seeded data; no drift |
| Nearby search (haversine default) | TESTED | `schema-v2-phase2.test.ts` 17 tests |
| PostGIS backend + optional GiST index + runbook | TESTED on disposable PostGIS 3.4.3 | `schema-v2-postgis.test.ts` 7 tests; production NOT enabled, pre-flight not yet run |
| Admin verify/block with audit | TESTED | phase 2 tests |
| Owner shop profile, paper options, photos (private, magic-byte checked) | TESTED | phase 2 tests |
| Customer discovery APIs | TESTED | phase 2 tests |
| Contract | IMPLEMENTED | `PHASE2_CONTRACT.md`, `POSTGIS_RUNBOOK.md` |

## Phase 3 - Customer orders (DEPLOYED, customer sign-up flag off so unused)

| Requirement | Status | Evidence |
|---|---|---|
| Customer uploads (existing pipeline, 50 MiB, hourly limit), quotes, orders (shared server-authoritative pricing), history, cancel; guest QR unchanged | MERGED | PR #51 squash `5184848`; 10 tests; full suite 61 files |
| 30-minute retention untouched; no customer file download | MERGED | by design |

## Phase 4 - Lifecycle and payments (MERGED to development, not deployed; PR #52, squash `43dd97b`)

| Requirement | Status | Evidence |
|---|---|---|
| REJECTED status behind `ORDER_REJECT_ENABLED` (default off), terminal handling everywhere | TESTED | `schema-v2-phase4.test.ts` |
| Cash/UPI tracking, UTR claim, duplicate UTR per shop, shop verification, concurrency | TESTED | 17 tests |
| Admin-only manual refund records, append-only payment events (DB trigger) | TESTED | 17 tests |
| Shop order list `/shops/{shopId}/orders`, status adapter | TESTED | 17 tests |
| Contract | IMPLEMENTED | `PHASE4_CONTRACT.md`; full suite 62 files green |

## Phase 5 - Reviews and notifications (DEPLOYED; PR #53 squash `fe72655`)

| Requirement | Status | Evidence |
|---|---|---|
| Reviews: one per order, eligibility, aggregate in the same transaction, listings, no edit/delete | TESTED | `schema-v2-phase5.test.ts` 15 tests |
| Customer notification inbox (outbox rows, read/read-all, retention) | TESTED | same |
| Customer + shop-owner push, token cleanup, failure isolation (fake sender) | TESTED | same |
| Shop-owner in-app inbox rows for payment submission / verification | NOT_STARTED (deferred to phase 6 with the web bell) | `PHASE5_CONTRACT.md` |
| Contract | IMPLEMENTED | `PHASE5_CONTRACT.md`; full suite 63 files green |

## Phase 6 - Integration

| Requirement | Status | Evidence |
|---|---|---|
| Web customer Google sign-in (cookie + CSRF) | DEPLOYED | `POST /auth/customer/google/session`, 5 tests |
| Customer web screens (sign-in, nearby, shop, order, orders, UPI ref, cancel, review, notifications) | DEPLOYED but OFF | built only with `VITE_MARKETPLACE=1`; 14 tests; PR #57 |
| OpenAPI for all new routes | MERGED when this PR lands | `openapi-schema-v2.yaml` validated (32 paths, 37 operations) |
| ER + sequence diagrams, architecture PDF, updated skill | MERGED when this PR lands | `13-final-er-and-sequence-diagrams.md`, `schema-v2-architecture.pdf` |
| Shop-owner / admin web screens for payments, verification, refunds, reviews | NOT_STARTED (API is complete and tested) | contracts in PHASE2/4/5 docs |
| Shop-owner in-app inbox rows for payment submission/verification | NOT_STARTED | deferred with the web bell |
| Android customer app | BLOCKED: source not in this repository; contract in OpenAPI + `10-android-integration-plan.md` | |
| PostGIS on production | BLOCKED/PENDING: pre-flight not run; haversine in use | `POSTGIS_RUNBOOK.md` |
| Off-server backup remote for the nightly job | BLOCKED: needs an owner-chosen destination and credentials | |
| Turning on customer sign-up / reject / marketplace flag | NOT_STARTED (owner decision) | |

## Blockers and notes

- Android source is not on the active branch: Android deliverable is the API contract and integration guide only.
- Production access (`kp-production`) not yet inspected; no production action has been taken.
