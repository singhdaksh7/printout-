# Order, pricing, payment and retention rules

## Order status

CURRENT_PRODUCTION (`apps/api/src/domain/lifecycle.ts`): NEW to ACCEPTED, CANCELLED or EXPIRED; ACCEPTED to PRINTING, CANCELLED or EXPIRED; PRINTING to PRINTED (print confirmation only) or EXPIRED (system only); PRINTED to READY; READY to COLLECTED. Terminal: COLLECTED, CANCELLED, EXPIRED. Cancellation is shop-side today.

PROPOSED (decision D7, owner preference pending): add `REJECTED` (NEW to REJECTED by the shop with a reason) through an additive migration, rolled out only after clients tolerate unknown statuses, then the shop action behind a flag; customer cancel from NEW/ACCEPTED. PDF names map to internal ones as in `docs/schema-v2/08` (pending=NEW, completed=COLLECTED). Single authority: `domain/lifecycle.ts`; transitions lock the order row, append history, write the outbox row, notify after commit; repeats are idempotent.

## Pricing

CURRENT_PRODUCTION: `PricingRule(shopId, paperSize, colourMode, sides)` with `pricePerSheetPaise`; the quote and order store `priceSnapshot` and `printOptionsSnapshot`; `totalPaise` is server-computed; history is never re-priced. PROPOSED (D2): customer-facing quotes come from the same server function and show the breakdown; PDF per-page fields are projections only; no stored per-page rates; no conversion of per-sheet to per-page.

## Payments (PROPOSED, D6)

unpaid to pendingVerification (customer submits UTR for UPI), to paid (shop confirms) or back to unpaid (shop rejects); cash unpaid to paid by shop; paid to refunded by a role to be decided (proposed admin-only, OPEN). `(shopId, upiTxnRef)` unique where not null; row lock and compare-and-set; history and audit; no automatic paid; no gateway; no card/PIN/bank data. Platform `Payment`/`Invoice`/`Subscription` stay dormant. The revenue report stays "estimated order value".

## Retention

CURRENT_PRODUCTION: `PRINT_RETENTION_MINUTES=30` after the first print action, `UNPRINTED_RETENTION_HOURS=24`, `UPLOAD_MAX_BYTES` 50 MiB. PROPOSED (D3): keep. The PDF's 7-day rule is **BLOCKED** pending separate owner approval; the customer file-download endpoint is BLOCKED with it.
