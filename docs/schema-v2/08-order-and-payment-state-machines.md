# 08 – Order and payment state machines (proposed)

## Current machine (`apps/api/src/domain/lifecycle.ts`)

```
NEW -> ACCEPTED | CANCELLED | EXPIRED
ACCEPTED -> PRINTING | CANCELLED | EXPIRED
PRINTING -> PRINTED (print confirmation only) | EXPIRED (system only)
PRINTED -> READY
READY -> COLLECTED
COLLECTED, CANCELLED, EXPIRED: terminal
```

Cancellation today is shop-side only. There is no REJECTED state; no customer actor; PRINTED is set only by print confirmation (Windows agent / device flow).

## PDF-to-current mapping (API aliases, no enum rename)

| PDF status | Internal | Note |
|---|---|---|
| pending | NEW | |
| accepted | ACCEPTED | |
| printing | PRINTING | |
| (none) | PRINTED | Internal only; exposed to PDF-style clients as `printing` |
| ready | READY | |
| completed | COLLECTED | |
| cancelled | CANCELLED | actor customer or shop |
| rejected | new `REJECTED` (decision D7, owner preference pending) | Until the additive migration ships and every client tolerates unknown statuses, a shop reject is the existing NEW -> CANCELLED with a reason. Rollout order is in 02 D7 |
| (none) | EXPIRED | Internal; PDF-style clients see `cancelled` |

## Target transition matrix

| From | To | Actor | Conditions |
|---|---|---|---|
| NEW | ACCEPTED | shop owner (membership) | shop not blocked |
| NEW | REJECTED | shop owner | `rejectReason` required; after D7 rollout only |
| NEW | CANCELLED | customer (owner of order) | optional `cancelReason` |
| ACCEPTED | PRINTING | shop owner / print-now | existing print path, unchanged |
| ACCEPTED | CANCELLED | customer or shop | allowed until printing starts |
| PRINTING | PRINTED | print confirmation only | existing |
| PRINTED | READY | shop | |
| READY | COLLECTED | shop | optional rule: require `paymentStatus = paid` (PDF leaves this open, default allow) |
| any non-terminal | EXPIRED | system worker | existing |

Rules: one module (`domain/lifecycle.ts`) is the only authority; routes and any PDF-style adapter call it. Each transition is one DB transaction that locks the order row, re-reads status (concurrency: loser gets 409 `INVALID_STATUS_TRANSITION`), inserts `OrderStatusHistory`, and writes the outbox notification. Push and SSE happen after commit; FCM failure never rolls back. Repeating the same target status by the same actor is idempotent (200, no new history). **No transition ever re-queues a physical print job**; retries stay in the device-job layer.

Customer cancel is blocked from PRINTING onward (409), matching the PDF.

## Payment machine (customer to shop; not platform billing)

```
unpaid -> pendingVerification   customer submits UTR (UPI orders only)
pendingVerification -> paid     shop owner verifies
pendingVerification -> unpaid   shop owner rejects (customer may resubmit)
unpaid -> paid                  shop owner confirms cash
paid -> refunded                admin only (proposed; refund permission needs approval)
```

Controls: `(shopId, upiTxnRef)` unique where not null (409 `DUPLICATE_UTR`); concurrent updates use row lock and compare-and-set on `paymentStatus`; every change is audited and appended to a payment history; a UTR is a claim, not proof; no automatic `paid`; no gateway.

Order status and payment status stay independent (a COLLECTED order may be unpaid).
