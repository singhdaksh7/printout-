# Phase 5 contract: reviews, ratings, notifications

Status: **IMPLEMENTED on branch `feature/daksh-schema-v2-phase5-reviews-notifications`; becomes CURRENT_PRODUCTION only when `IMPLEMENTATION_PROGRESS.md` says DEPLOYED with evidence.** Additive. All routes require the stated principal; error envelope as everywhere else.

## Reviews and ratings

| Route | Notes |
|---|---|
| `POST /customer/reviews` `{ orderId, rating 1..5 (integer), comment? <= 1000 }` | Customer of that order only (another customer's order, an unknown id: `404`). One review per order (`409 REVIEW_EXISTS`, also under concurrency). **Eligible once the shop's Print has started** (status `PRINTING`, `PRINTED`, `READY` or `COLLECTED`), else `422 ORDER_NOT_COMPLETED`. Assumption recorded: in this system the Print action is the shop's completion signal; the legacy ready/collected steps no longer exist in the shop UI, so waiting for `COLLECTED` would make reviews impossible. Cancelled, rejected, expired, new and accepted orders are refused. Comment: trimmed, control characters refused, blank means none, stored as plain text (**clients must escape on display**). 30 reviews per customer per 24 h (`429`). No edit and no delete in v1 (no such routes). |
| `GET /customer/shops/{shopId}/reviews?page&limit` | Verified ACTIVE shops only (else `404`). Newest first, `{ items: [{ id, rating, comment, customerName, createdAt }], page, limit, total, ratingAvg, ratingCount }`. `customerName` is abbreviated ("Alice B."); ids, emails and order ids are never returned. |
| `GET /shops/{shopId}/reviews` | Same payload for the owner of that shop (a foreign shop is `404`). |

Aggregate: `Shop.ratingSum`, `ratingCount`, `ratingAvg` are updated in the same transaction as the review (row-locked order, atomic `UPDATE`), `ratingAvg = round(sum / count, 1)`, verified equal to `AVG(rating)` of the reviews table. Shop cards and the nearby list now return real `ratingAvg` (null while unreviewed) and `ratingCount`. Customer order views include `isReviewed`. Database CHECKs: rating 1..5, comment length; unique `orderId`.

## Customer notifications

Events (generic texts with the order number only; no file names, amounts, payment references, reasons or contact data): order rejected, order cancelled by the shop, printing started, order expired (worker), payment received, payment reference not accepted (once per rejection), refund recorded. A customer's own cancellation and all guest QR orders produce nothing.

| Route | Notes |
|---|---|
| `GET /customer/notifications?page&limit&unread=true` | `{ items: [{ id, type orderStatus|payment, title, body, orderId, readAt, createdAt }], page, limit, total, unreadCount }`, newest first. Own rows only. |
| `POST /customer/notifications/{id}/read` | `204`, idempotent (first `readAt` kept); another user's id is `404`. |
| `POST /customer/notifications/read-all` | `{ updated }`. |

Delivery model: the inbox row is written **inside** the transaction that changes the order or payment (transactional outbox, unique per user and event), then a best-effort **push after commit**. A push failure never rolls anything back. Retention follows `NOTIFICATION_RETENTION_DAYS` (same worker as shop notifications).

## Push (FCM)

- Customers register devices with the existing `PUT/DELETE /users/me/fcm-token` (now open to the `CUSTOMER` role as well as shop owners; admins still `403`) or the `fcmToken` field of `POST /auth`. Tokens stay encrypted at rest and are never returned. A token re-registered by another authenticated user moves to that user only (never shared).
- Customer pushes go only to that customer's own registrations (CUSTOMER role, active account); payload `{ type: order.updated|payment.updated, orderId, title }`. Shop owners get a push when a customer submits a UPI reference (`order.payment_submitted`). Dead tokens reported by FCM (`not-registered`, `invalid`) are revoked immediately; repeated failures revoke after `FCM_FAILURE_REVOKE_AFTER`; a total FCM outage is ignored by the request.
- Tested with a fake sender only; no real FCM calls were made.

## Deferred to phase 6 (explicit)

Shop-owner in-app inbox rows for payment submissions and admin verification changes (the existing `ShopNotification` bell is built around new-order events and would mislabel other types until the web bell is updated in phase 6), and a push on verification/unverification. Nothing existing was changed for owners.

## Database (migration `20261028140000_reviews_customer_notifications`)

`Shop.ratingSum/ratingCount/ratingAvg`, `Order.isReviewed`, tables `Review` (FKs `RESTRICT`) and `UserNotification` (CHECK `type`). Verified on disposable PG16; `prisma migrate diff` clean.
