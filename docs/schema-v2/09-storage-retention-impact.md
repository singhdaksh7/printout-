# 09 – Storage and retention impact analysis

**No retention change is made by this work. The owner must approve one of the options below.**

| Item | Current (`apps/api/src/config.ts`) | PDF target |
|---|---|---|
| After the first Print action | `PRINT_RETENTION_MINUTES` = 30 (`Document.deleteAfter`) | 7 days after completed, cancelled or rejected |
| Never printed | `UNPRINTED_RETENTION_HOURS` = 24 | orphan upload deleted after 24 h; unused-by-order |
| Max upload | `UPLOAD_MAX_BYTES` 50 MiB (ceiling 100 MiB) | 20 MB |
| Signed URL | upload token 15 min; HMAC download for local driver | download 2 to 5 min |
| Receipt | `DeletionReceipt` model exists (unused) | `fileDeletedAt` |
| Notification retention | 14 days | not specified |

## Impact of moving 30 minutes to 7 days

- **Privacy**: customer documents (IDs, forms, financial papers) would sit in storage about 336 times longer; the product's privacy notice and any customer consent text would have to change before launch; the web `RetentionNotice` component and API field `retentionMinutes` expose today's promise.
- **Cost**: storage = average daily upload volume x 7. At 1,000 orders/day of 2 MB, about 14 GB steady state; low cost, but backup size grows.
- **Backups**: files must be excluded from, or aged out of, backups; otherwise deletion is not real.
- **Windows spool and Android local copies**: deleting the R2 object does not delete local spool/cache files. Those follow the agent/device policy and are a separate deletion path; do not claim deletion of originals covers them.
- **Active and failed jobs**: the worker must not delete a document while a `DevicePrintJob` or order is still non-terminal; the existing `Document.status` machine (`PRINTED_RETENTION`, `deletionAttempts`, `lastDeletionAttemptAt`) already supports retry; keep it idempotent and restart-safe.
- **Guest QR uploads**: they have no order account; the 24 h unprinted rule remains; any 7-day rule would apply only to authenticated customer orders if approved (a per-source policy is an option).
- **Re-download for customers** (`GET /orders/{id}/file`) is the product reason for 7 days; an alternative is to keep 30 minutes and omit that endpoint.

## Options

A. Keep 30 minutes; customer file download endpoint not offered. B. Per-source: 30 minutes for guest, 7 days for authenticated customer orders. C. 7 days for all.

Owner preference recorded (02 D3, pending confirmation): option A. Recommendation: A for the first release, with B revisited once a privacy notice is drafted. Implementation of any option stays behind configuration plus a worker update; cleanup must remain idempotent with storage-failure retries.
