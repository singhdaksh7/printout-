# Schema V2 implementation progress

Status values: NOT_STARTED, IN_PROGRESS, IMPLEMENTED, TESTED, MERGED, DEPLOYED (only with verified production evidence), BLOCKED. Resume rule: a new session reads this file, `02-architecture-decisions.md` and the architecture skill, then continues at the first row that is not MERGED/DEPLOYED.

## Repository state

| Step | Status | Evidence |
|---|---|---|
| Docs PR #45 | MERGED | `62d60b0` |
| Skill PR #46 | MERGED | `647d45a` |
| Decisions recorded APPROVED | IN_PROGRESS | branch `docs/schema-v2-approvals` |
| development/main sync (PR #47) | IN_PROGRESS | candidate tree identical to main |

## Phase 1 - Identity and multi-shop

| Requirement | Status |
|---|---|
| Regression tests pinning auth, /public, lifecycle contracts | NOT_STARTED |
| `CUSTOMER` role, `UserRoleGrant` | NOT_STARTED |
| Nullable email (customer-only DB check) | NOT_STARTED |
| Customer profile fields | NOT_STARTED |
| `GET /shops/mine` + Membership-scoped authorization | NOT_STARTED |
| Backward-compatible customer sign-in | NOT_STARTED |

## Phases 2-6

All requirements listed in the owner authorization (discovery/PostGIS, customer orders, lifecycle + payments + REJECTED, reviews + notifications, integration + OpenAPI + PDF + rollout) are NOT_STARTED. Production deployment, migration and PostGIS enablement: none performed.

## Blockers and notes

- Android source is not on the active branch: Android deliverable is the API contract and integration guide only.
- Production access (`kp-production`) not yet inspected; no production action has been taken.
