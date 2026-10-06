# Phase 1: one-click Print workflow

Shop owners do not run an order-management workflow. Customer uploads -> new print request -> **Print** -> document opens -> 30-minute retention -> **Reprint** -> document deleted.

## Retention semantics

| Event | `Document.printInitiatedAt` | `Document.deleteAfter` |
| --- | --- | --- |
| Upload completes | `NULL` | `NULL` (only `expiresAt` = +24 h unprinted rule) |
| View queue / details / metadata | unchanged | unchanged |
| First successful Print (`POST /shop/orders/:id/print-now`) | server `now()` | `printInitiatedAt` + `PRINT_RETENTION_MINUTES` (30) |
| Print again / Reprint / reopen / retry | unchanged | unchanged |
| Save File (`document-download`) | unchanged | unchanged |
| `now >= deleteAfter` | - | access denied (409/410) by Print, Reprint, document-access, document-download and the signed local route, before the worker deletes the object |

The first Print is a conditional `updateMany` (`status=AVAILABLE AND printInitiatedAt IS NULL AND printedAt IS NULL AND expiresAt > now`), so double clicks and races have exactly one winner. The access URL is produced **before** the transaction: if URL generation fails nothing is written and no retention starts.

`printInitiatedAt` means **Print was initiated** (authorised, document opened). It does not prove paper came out; user-facing and audit wording says "Print started", "Print initiated", "Available for reprint", "File deleted automatically". Audit actions: `order.printInitiated` (once), `order.printNow`, `document.access` (open/reprint), `document.download` (Save File).

## Internal state mapping

| Status | New-flow meaning | Who can set it | Shown to shop owner |
| --- | --- | --- | --- |
| `NEW` | request waiting for Print | customer order creation | "New" tab with Print |
| `ACCEPTED` | transient internal step | Print (inside the same transaction, history reason `Print`) | never as a step; hidden from analytics activity |
| `PRINTING` | **Print initiated** (new-flow resting state) | Print | "Print started" chip, "Recent" tab, Reprint while retained |
| `PRINTED` | legacy: shop confirmed printout | only existing rows | read-only label "Print confirmed (legacy)" |
| `READY` | legacy | only existing rows | read-only label "Ready (legacy)" |
| `COLLECTED` | legacy, terminal | only existing rows | read-only label "Collected (legacy)" |
| `CANCELLED` | shop owner cancelled a NEW order | `POST /transitions` with `toStatus: CANCELLED` | "Cancelled / expired" tab |
| `EXPIRED` | unprinted 24 h expiry | system worker | "Cancelled / expired" tab |

A new-flow order stays `PRINTING` after its file is deleted; `Document.status = DELETED` is what the UI shows as "File deleted automatically". Legacy rows (`printedAt` set, no `printInitiatedAt`) are treated as "print initiated" at `printedAt` for display, remain reprintable until their existing `deleteAfter`, and are deleted by the same worker. No backfill is performed; historical `deleteAfter` values stay authoritative.

## Retired shop-owner API surface

* `POST /shop/orders/:id/transitions` accepts **only** `toStatus: "CANCELLED"` (any other value -> 400 `VALIDATION_ERROR`). Accept / Start printing / Ready / Collected can no longer be performed by a shop owner.
* `POST /shop/orders/:id/print-confirmation` is **retired**: after authentication it returns 410 `ENDPOINT_RETIRED` and changes nothing.
* The state machine in `domain/lifecycle.ts`, history and audit rows are unchanged, so legacy records stay readable.

## Analytics (`GET /shop/analytics`)

New fields: `printsInitiated` (orders created in range whose document has `printInitiatedAt`, or legacy `printedAt`), `newPrintRequests` (live orders nobody pressed Print on; not range-limited), `documentsAutoDeleted` (documents deleted in range). `ordersByStatus` is kept for compatibility but is not shown in the UI because `PRINTING` is a resting state, not a backlog.

## Migration

`20261005200000_print_initiated_at`: `ALTER TABLE "Document" ADD COLUMN "printInitiatedAt" TIMESTAMP(3);` Additive, nullable, no backfill. Production: `prisma migrate deploy` only.
