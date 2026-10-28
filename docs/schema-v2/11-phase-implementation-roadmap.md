# 11 – Phase implementation roadmap

Each phase: own branch from `development` after `development` is re-synced with `main` (see 12, branch base), own PR, migrations only if listed, tests, review, CI green, rollback plan, compatibility report. Nothing deploys automatically.

| Phase | Scope | Migrations | Blocked on |
|---|---|---|---|
| 0 | This documentation PR | none | review |
| 1 Identity + multi-shop | `CUSTOMER` role, `UserRoleGrant`, nullable email, `GET /shops/mine`, `Membership` checks on new routes | M1 | AD-3 and D5 confirmation; email-null audit |
| 2 Discovery | shop profile columns, verification flag + admin verify/block + audit, paper options, shop images, nearby search (PostGIS per D4, haversine fallback behind one interface) | M2, M3, M4 | D4 confirmation, non-production PostGIS test, production permission check; address model |
| 3 Customer ordering | customer uploads, order create via shared pricing, history, customer cancel | M5 | D2 (per-sheet quotes), D3 (30-min retention; no customer file download) |
| 4 Lifecycle + payments | state-machine adapter, reject, cash/UPI tracking | M6 | D6, D7 rollout order, refund permission; Phase B coordination |
| 5 Reviews + notifications | reviews, rating aggregate, customer FCM, `UserNotification` | M6 | |
| 6 Retention + rollout | retention only if separately approved (D3 keeps 30 min), worker alignment, Android, web, regression, staged release | config | D3 |

Safe foundation work that needs no policy decision, proposed as the first implementation PR after this one: tests that pin the current lifecycle and `/public` contract (regression net), then M1 additive migration on a disposable database.
