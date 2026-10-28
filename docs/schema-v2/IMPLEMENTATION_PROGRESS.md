# Schema V2 implementation progress

Status values: NOT_STARTED, IN_PROGRESS, IMPLEMENTED, TESTED, MERGED, DEPLOYED (only with verified production evidence), BLOCKED. Resume rule: a new session reads this file, `02-architecture-decisions.md` and the architecture skill, then continues at the first row that is not MERGED/DEPLOYED.

## Repository state

| Step | Status | Evidence |
|---|---|---|
| Docs PR #45 | MERGED | `62d60b0` |
| Skill PR #46 | MERGED | `647d45a` |
| Decisions recorded APPROVED | IN_PROGRESS | branch `docs/schema-v2-approvals` |
| development/main sync (PR #47) | IN_PROGRESS | candidate tree identical to main |

## Phase 1 - Identity and multi-shop (MERGED to development, not deployed)

| Requirement | Status | Evidence |
|---|---|---|
| Customer role, role grants, nullable email, customer profile, `GET /shops/mine`, customer sign-in (audience), onboarding (flag off) | MERGED | PR #49, squash `2b17805`; 23 tests + full suite 58 files |

## Phase 2 - Discovery (MERGED to development, not deployed; PR #50, squash `d8baff6`)

| Requirement | Status | Evidence |
|---|---|---|
| Shop address, coordinates, verification columns; paper options; photos (migration `20261028110000`) | TESTED | disposable PG16 upgrade with seeded data; no drift |
| Nearby search (haversine default) | TESTED | `schema-v2-phase2.test.ts` 17 tests |
| PostGIS backend + optional GiST index + runbook | TESTED on disposable PostGIS 3.4.3 | `schema-v2-postgis.test.ts` 7 tests; production NOT enabled, pre-flight not yet run |
| Admin verify/block with audit | TESTED | phase 2 tests |
| Owner shop profile, paper options, photos (private, magic-byte checked) | TESTED | phase 2 tests |
| Customer discovery APIs | TESTED | phase 2 tests |
| Contract | IMPLEMENTED | `PHASE2_CONTRACT.md`, `POSTGIS_RUNBOOK.md` |

## Phase 3 - Customer orders (MERGED to development, not deployed)

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

## Phase 5 - Reviews and notifications (PR open into development, not deployed)

| Requirement | Status | Evidence |
|---|---|---|
| Reviews: one per order, eligibility, aggregate in the same transaction, listings, no edit/delete | TESTED | `schema-v2-phase5.test.ts` 15 tests |
| Customer notification inbox (outbox rows, read/read-all, retention) | TESTED | same |
| Customer + shop-owner push, token cleanup, failure isolation (fake sender) | TESTED | same |
| Shop-owner in-app inbox rows for payment submission / verification | NOT_STARTED (deferred to phase 6 with the web bell) | `PHASE5_CONTRACT.md` |
| Contract | IMPLEMENTED | `PHASE5_CONTRACT.md`; full suite 63 files green |

## Phase 6

Web and admin UI, OpenAPI, ER and sequence diagrams, architecture PDF, skill update, production pre-flight and rollout are NOT_STARTED. No production access, migration, PostGIS enablement or deployment has been performed.

## Blockers and notes

- Android source is not on the active branch: Android deliverable is the API contract and integration guide only.
- Production access (`kp-production`) not yet inspected; no production action has been taken.
