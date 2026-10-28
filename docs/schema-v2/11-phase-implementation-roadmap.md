# 11 – Phase implementation roadmap

Each phase: own branch from `development` (or `main` per the owner's branch policy), own PR, migrations only if listed, tests, review, CI green, rollback plan, compatibility report. Nothing deploys automatically.

| Phase | Scope | Migrations | Blocked on |
|---|---|---|---|
| 0 | This documentation PR | none | review |
| 1 Identity + multi-shop | `CUSTOMER` role, `UserRoleGrant`, nullable email, `GET /shops/mine`, `Membership` checks on new routes | M1 | AD-3, AD-5 approval; email-null audit |
| 2 Discovery | shop profile columns, verification flag + admin verify/block + audit, paper options, shop images, nearby search (haversine) | M2, M3, M4 (PostGIS later) | PostGIS permission; address model |
| 3 Customer ordering | customer uploads, order create via shared pricing, history, customer cancel | M5 | pricing decision (AD-8); retention decision |
| 4 Lifecycle + payments | state-machine adapter, reject, cash/UPI tracking | M6 | AD-13; REJECTED decision; Phase B coordination |
| 5 Reviews + notifications | reviews, rating aggregate, customer FCM, `UserNotification` | M6 | |
| 6 Retention + rollout | approved retention, worker alignment, Android, web, regression, staged release | config | AD-14 |

Safe foundation work that needs no policy decision, proposed as the first implementation PR after this one: tests that pin the current lifecycle and `/public` contract (regression net), then M1 additive migration on a disposable database.
