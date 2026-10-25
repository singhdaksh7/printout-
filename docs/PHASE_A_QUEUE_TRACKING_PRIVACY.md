# Phase A: live queue, customer tracking, privacy

## Audit of what already existed (not rebuilt)

| Area | Already implemented |
| --- | --- |
| Realtime | One SSE stream per shop (`/shop/events`) with heartbeat, event-id de-duplication, backoff reconnect, refetch after a gap; 45 s safety-net polling; offline banner + connection chip in the shop shell |
| Queue | New / Recent / Cancelled-expired tabs, keyset pagination, countdowns, alert sound with a mute switch, tab-title badge, stats strip, cancel with a confirmation dialog |
| Printing | `DevicePrintJob` lifecycle with lease recovery; a job that may have reached the spooler is **never** re-queued (ends in `NEEDS_RECONCILIATION`, a human decides); retry/reconcile UI with a duplicate-risk confirmation |
| Tracking | `GET /public/orders/:token` (256-bit random token, constant 404, per-IP rate limit), 5 s adaptive polling with back-off, timeline, retention countdown |
| Retention | Worker deletes printed documents at `deleteAfter` (print initiated + `PRINT_RETENTION_MINUTES`) and unprinted ones at `expiresAt` (24 h); delete-then-verify, conditional DB update (safe under concurrent workers and restarts), audit rows, never deletes orders |
| Agent | Temp files live in an ACL-restricted per-job random directory, removed after use, swept on start and periodically |

Backend lifecycle note: shop owners can only *cancel*; **Print** performs `NEW -> ACCEPTED -> PRINTING` itself, and `PRINTED/READY/COLLECTED` exist only for legacy rows. The user-facing labels map onto these existing states; no enum was changed.

| User-facing label | Backend source |
| --- | --- |
| New | `NEW` (Print not yet pressed) |
| Printing | `PRINTING` / Print initiated |
| Ready / Collected | legacy `READY` / `COLLECTED` (still rendered) |
| Cancelled / Expired | `CANCELLED` / `EXPIRED` |
| Needs attention | latest `DevicePrintJob` is `FAILED` or `NEEDS_RECONCILIATION` |

## Delivered in this branch (all additive, no migration)

* `GET /shop/orders?sort=oldest|newest` (default newest, cursor follows the direction) and `?print=attention`.
* `GET /shop/orders/counts` -> `{ pending, attention }` (tenant-scoped, session-protected, no order data).
* Queue UI: "Needs attention" tab (shown only while something needs it), sort selector, Waiting-for-print count already in the stats strip.
* Tracking (`/public/orders/:token`): additive `pickup { address, contact }` and `printIssue` (coarse boolean; no printer, device, job or error detail). The file name is no longer returned once the file is deleted. Tracking page shows pickup details, a ready-for-pickup message, an order-complete message, a print-issue note and a privacy note.
* Cleanup: a document whose print job an agent holds a **live lease** on (`CLAIMED/DOWNLOADING/SUBMITTING/SUBMITTED_TO_SPOOLER`) is spared for at most `DOCUMENT_ACTIVE_JOB_GRACE_MINUTES` (default 5, `0` disables) past its deadline, then deleted regardless. This is the only retention extension, it is hard-capped, and it is reported as `deferred`. Failed deletions now increment `deletionAttempts` / `lastDeletionAttemptAt`.

Not done, deliberately: an **estimated ready time** (there is no throughput data, so any number would be invented); a **pickup code** separate from the order reference (the order number is already the human reference and the tracking token is the secret); WebSockets (SSE already covers the need).

## Privacy limits (what cleanup cannot guarantee)

Server cleanup removes the stored object and marks the row `DELETED`. It cannot remove copies that live outside the server: the shop computer's Windows print spooler and its drivers, printer memory, files the shopkeeper chose to "Save file", browser downloads/caches on the shop PC, or infrastructure backups of the storage bucket. The Windows agent deletes its own temp directory after each job and sweeps leftovers, but a spooled job may persist in the Windows spool until the spooler purges it. Say this to shops during onboarding; do not promise more to customers than "deleted from our servers".
