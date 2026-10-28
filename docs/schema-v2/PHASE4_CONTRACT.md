# Phase 4 contract: lifecycle (REJECTED) and payments

Status: **IMPLEMENTED on branch `feature/daksh-schema-v2-phase4-lifecycle-payments`; becomes CURRENT_PRODUCTION only when `IMPLEMENTATION_PROGRESS.md` says DEPLOYED with evidence.** Additive. Platform stays free: this tracks what a customer owes a **shop**; there is no gateway, no automatic payment, no platform billing.

## REJECTED (decision D7, flag `ORDER_REJECT_ENABLED`, default off)

- Migration `20261028130000_order_rejected_enum` adds the enum value only. Nothing sets it while the flag is off (`409 FEATURE_DISABLED`). **Rollout order:** ship clients that tolerate an unknown order status (web queue/tracking/history, Android owner and customer apps), then turn the flag on.
- `NEW -> REJECTED` by the shop, reason required (`400` without). Terminal. Refused while a payment is claimed or recorded (`409 PAYMENT_RECORDED`). Idempotent. Append-only history and audit as for every transition.
- Available through the existing `POST /shop/orders/:id/transitions` (`toStatus` now `CANCELLED` or `REJECTED`; the CANCELLED behaviour and contract are unchanged) and the new `PATCH /shops/{shopId}/orders/{orderId}/status` `{ status: rejected|cancelled, rejectReason? }`. `accepted|printing|ready|completed` are refused with `409` (they are produced by the Print action and the device flow, not set directly).
- REJECTED is excluded everywhere CANCELLED/EXPIRED are: no document access, not counted as order value, hidden from active lists, no device print job. It reports with the cancelled orders in existing aggregate shapes.
- Windows Agent and device routes are unchanged; a rejected order can never be printed or replayed.

## Payments

States (API spelling): `unpaid`, `pendingVerification`, `paid`, `refunded`; methods `cash`, `upi`. Order status and payment status are independent.

| Action | Route | Rules |
|---|---|---|
| Choose method | `POST /customer/orders` `paymentMethod` (now **required** on this new route) | Must be accepted by the shop; UPI needs the shop's UPI ID, else `400 PAYMENT_METHOD_NOT_ACCEPTED`. |
| Shop payment settings | `PATCH /shops/{shopId}` `upiId`, `acceptedPaymentMethods` | `upiId` format `name@bank`; UPI cannot be accepted without a UPI ID and the ID cannot be removed while UPI is accepted. Default `["cash"]`. Customers see the UPI ID only when UPI is accepted. |
| Submit UPI reference | `POST /customer/orders/{id}/payment` `{ upiTxnRef }` | 8-22 letters/digits, normalised to upper case. `unpaid -> pendingVerification` only; **a claim, not proof**. `409 DUPLICATE_UTR` if the shop already has that reference on another order; `409 NOT_UPI_ORDER`; `409 INVALID_PAYMENT_TRANSITION` (already submitted, order closed). |
| Shop decision | `PATCH /shops/{shopId}/orders/{orderId}/payment` `{ paymentStatus: paid|unpaid }` | Cash: `unpaid -> paid` (received). UPI: `pendingVerification -> paid` (verified) or `-> unpaid` (reference rejected and cleared; customer may resubmit). Anything else `409`. Only the shop owner of that order's shop; a customer can never mark paid. Orders without a method (guest QR) cannot be marked. |
| Manual refund record | `POST /admin/orders/{id}/refund` `{ reason, amountPaise? }` | **Platform admin only.** `paid -> refunded`, reason 3-300 chars, amount 1..order total (default total). Records a refund made outside the platform; no money moves. |

Concurrency: payment actions take a row lock on the order; of simultaneous identical decisions exactly one succeeds. A customer cannot cancel while a payment is claimed or recorded (`409 PAYMENT_RECORDED`) until the shop rejects the claim.

Evidence: every payment change appends an `OrderPaymentEvent` (event, from/to, reference, amount, reason, actor role) and an audit entry; a database trigger forbids UPDATE and DELETE of events.

## Shop order list (multi-shop)

`GET /shops/{shopId}/orders?status&page&limit` returns `{ items, page, limit, total }` with `customerName` (display name only; never the customer's phone or email), print options, note, `paymentMethod`, `paymentStatus`, `upiTxnRef`. Foreign shop ids are `404`.

## Database (migrations `...130000_order_rejected_enum`, `...130100_customer_payments`)

Enum `OrderStatus` + `REJECTED`; enums `PaymentMethod`, `PaymentStatus`; `Shop.upiId`, `Shop.acceptedPaymentMethods` (default cash); `Order.paymentMethod` (null for guest/historical orders), `paymentStatus` (default unpaid), `upiTxnRef` with unique `(shopId, upiTxnRef)`; table `OrderPaymentEvent` with CHECK constraints and the append-only trigger. Existing rows are unchanged; `prisma migrate diff` clean.

## Android notes

Owner app: unchanged until the flag is on; then handle status `REJECTED` and optionally `PATCH /shops/{shopId}/orders/{orderId}/payment`. Customer app: send `paymentMethod`; for UPI show `payment.upiId`, collect the reference, call `.../payment`, and poll the order for `payment.status`.
