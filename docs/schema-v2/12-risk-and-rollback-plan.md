# 12 – Risk and rollback plan

| # | Risk | Likelihood | Impact | Mitigation | Rollback |
|---|---|---|---|---|---|
| 1 | Making `User.email` nullable breaks code assuming non-null | medium | high | grep and type-check all consumers first; keep partial unique | old code ignores new rows; revert app, keep column |
| 2 | Per-page vs per-sheet mispricing | high if naive | high (money) | keep per-sheet, never convert silently | none needed (not built) |
| 3 | Switching to Firebase ID tokens on every call | n/a | critical | rejected (AD-3) | n/a |
| 4 | Auto-linking by phone/email (PDF login/admin-create) | n/a | critical account takeover | rejected (AD-6) | n/a |
| 5 | Retention raised to 7 days without notice | medium | privacy | owner approval (09) | revert config; worker deletes backlog idempotently |
| 6 | PostGIS unavailable or extension needs superuser | medium | blocks geo | test on a disposable PostGIS DB; check `pg_available_extensions`; keep a haversine fallback behind the repository interface | no extension created |
| 7 | Unverified backfill hides existing shops | low | revenue | backfill `isVerified=true` in same release | set flags back |
| 8 | New `REJECTED` enum breaks Android/agent | medium | high | clients tolerate unknown statuses before the value is added (D7) | enum value is inert if unused; reject action behind a flag |
| 9 | Duplicate printing from status replays | low | high | no transition re-queues print jobs; retries stay in device-job layer | n/a |
| 10 | Overlap with Phase B (printers, device jobs) | high | merge conflict | leave `Device*`/`PrintAgent`/`Printer` untouched; coordinate | n/a |
| 11 | FCM token reassignment across users | medium | privacy | rule 6 in 06 | revoke registrations |
| 12 | UTR treated as proof of payment | medium | financial dispute | shop-only `paid`; wording in UI | n/a |

| 13 | `development` is behind `main` (9 commits on `main` not in `development`, 26 the other way); a PR based on either can carry or miss unrelated changes | high | merge conflicts, features built on stale code | Docs-only PRs are safe on either base. Before Phase 1 code: merge `main` into `development` via the existing sync-PR pattern (`chore/sync-hotfix-34-to-development`), verify CI, then branch Phase 1 from `development`. Never rewrite either branch | n/a |

Global rules: backup and restore trial before any production migration; disposable databases for tests; no production writes, deploys or pushes to long-lived branches without explicit approval; preserve the Print-keep bundle, Android/UI patches, backups, env files and the recovery key.
