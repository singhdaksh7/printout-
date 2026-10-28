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

## Phase 2 - Discovery (PR open into development, not deployed)

| Requirement | Status | Evidence |
|---|---|---|
| Shop address, coordinates, verification columns; paper options; photos (migration `20261028110000`) | TESTED | disposable PG16 upgrade with seeded data; no drift |
| Nearby search (haversine default) | TESTED | `schema-v2-phase2.test.ts` 17 tests |
| PostGIS backend + optional GiST index + runbook | TESTED on disposable PostGIS 3.4.3 | `schema-v2-postgis.test.ts` 7 tests; production NOT enabled, pre-flight not yet run |
| Admin verify/block with audit | TESTED | phase 2 tests |
| Owner shop profile, paper options, photos (private, magic-byte checked) | TESTED | phase 2 tests |
| Customer discovery APIs | TESTED | phase 2 tests |
| Contract | IMPLEMENTED | `PHASE2_CONTRACT.md`, `POSTGIS_RUNBOOK.md` |

## Phases 2-6

Phases 3-6 (customer orders, lifecycle + payments + REJECTED, reviews + notifications, integration + OpenAPI + PDF + rollout) are NOT_STARTED. Production deployment, migration and PostGIS enablement: none performed.

## Blockers and notes

- Android source is not on the active branch: Android deliverable is the API contract and integration guide only.
- Production access (`kp-production`) not yet inspected; no production action has been taken.
