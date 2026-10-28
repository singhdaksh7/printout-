# 05 – API contract mapping

Labels: CURRENT_LIVE (exists, same meaning), CURRENT_DIFFERENT_CONTRACT (live route with a different contract from the PDF), NEW_PROPOSED (not in code, not production-ready), DEPRECATED.

Base URL: `https://printoutbuddy.tech/api/v1` (never the PDF placeholder). Envelopes stay `{data}` / `{error:{code,message,requestId,details}}`. Pagination for new list routes is proposed as `{data:{items,page,limit,total}}` with max limit 50, matching the PDF values inside the current envelope.

| PDF endpoint | Existing route | Label | Proposed route / adapter | Auth |
|---|---|---|---|---|
| POST /auth/login | `POST /auth` (mobile), web exchange routes | CURRENT_DIFFERENT_CONTRACT | Keep. Extend `POST /auth` so a verified Google/phone identity with no account can become a **customer** (new `nextStep`), without silent owner linking | none |
| GET /me | `GET /users/me` | CURRENT_DIFFERENT_CONTRACT | Add customer fields additively | any session |
| PATCH /me | `PATCH /users/me` | CURRENT_DIFFERENT_CONTRACT | Add address, lat/lng | any session |
| PUT /me/fcm-token | `PUT /users/me/fcm-token` | CURRENT_DIFFERENT_CONTRACT | Allow customer principal | any session |
| DELETE /me/fcm-token | `DELETE /users/me/fcm-token` | CURRENT_DIFFERENT_CONTRACT | same | any session |
| GET /shops/nearby | none | NEW_PROPOSED | `GET /customer/shops/nearby` | customer |
| GET /shops/{shopId} | `GET /public/shops/:slug` | CURRENT_DIFFERENT_CONTRACT | New `GET /customer/shops/{shopId}` returning rates, paper options, photos; public slug route unchanged | customer |
| GET /shops/{shopId}/reviews | none | NEW_PROPOSED | `GET /customer/shops/{shopId}/reviews` | customer |
| POST /uploads/presign | `POST /public/shops/:slug/uploads/initiate` + upload PUT (HMAC token) | CURRENT_DIFFERENT_CONTRACT | `POST /customer/uploads/presign` wrapping the same storage driver; keys scoped `uploads/{userId}/...` | customer |
| POST /orders | `POST /public/shops/:slug/orders` | CURRENT_DIFFERENT_CONTRACT | `POST /customer/orders` sharing pricing and validation | customer |
| GET /orders, GET /orders/{id} | `GET /public/orders/:token` (capability) | CURRENT_DIFFERENT_CONTRACT | `GET /customer/orders`, `GET /customer/orders/{id}` | customer |
| GET /orders/{id}/file | shop document routes | CURRENT_DIFFERENT_CONTRACT | **BLOCKED** while 30-minute retention stands (D3): not offered to customers. If 7-day retention is separately approved: `GET /customer/orders/{id}/file` (short-lived URL, 410 after deletion). Shop access stays on shop routes | customer |
| POST /orders/{id}/cancel | cancel is shop-side only today | NEW_PROPOSED | `POST /customer/orders/{id}/cancel` (NEW/ACCEPTED only) | customer |
| POST /orders/{id}/payment | none | NEW_PROPOSED | `POST /customer/orders/{id}/payment` (UTR) | customer |
| POST /reviews | none | NEW_PROPOSED | `POST /customer/reviews` | customer |
| GET /shops/mine | `GET /shops/me` | CURRENT_DIFFERENT_CONTRACT | New `GET /shops/mine` from `Membership`; `/shops/me` unchanged | owner |
| PATCH /shops/{id} | `PATCH /shops/me`, `PUT /shop/settings` | CURRENT_DIFFERENT_CONTRACT | `PATCH /shops/{shopId}`; owner may not set verified/status | owner + membership |
| PUT /shops/{id}/rates | `/shop/pricing-rules` | CURRENT_DIFFERENT_CONTRACT | Keep per-sheet; no PDF per-page endpoint until approved | owner |
| PUT /shops/{id}/paper-options | none | NEW_PROPOSED | `PUT /shops/{shopId}/paper-options` | owner |
| POST /shops/{id}/images | none | NEW_PROPOSED | `POST /shops/{shopId}/images` (storage key, ownership, size, type, HEAD check) | owner |
| GET /shops/{id}/orders | `/shop/orders*` | CURRENT_DIFFERENT_CONTRACT | `GET /shops/{shopId}/orders` thin adapter | owner |
| PATCH /shops/{id}/orders/{oid}/status | `/shop/orders/:id/*` transitions | CURRENT_DIFFERENT_CONTRACT | Adapter over the single state machine (08) | owner |
| PATCH .../payment | none | NEW_PROPOSED | `PATCH /shops/{shopId}/orders/{orderId}/payment` | owner |
| POST /admin/shops | `POST /admin/shops` | CURRENT_DIFFERENT_CONTRACT | Keep; remove nothing. No reuse-by-phone | admin + 2FA |
| GET /admin/shops | `GET /admin/shops` | CURRENT_LIVE (filter `isVerified` NEW) | add filter | admin |
| PATCH /admin/shops/{id}/verify | none | NEW_PROPOSED | with AuditLog | admin |
| PATCH /admin/shops/{id}/block | `PUT /admin/shops/:id` (status) | CURRENT_DIFFERENT_CONTRACT | thin wrapper | admin |

DEPRECATED: none introduced. Existing deprecated route is documented in `docs/architecture/api-inventory.md`.

Rules for every NEW_PROPOSED route: strict body schema, per-principal rate-limit bucket, tenant check from the session (never from the client), `Idempotency-Key` on creates, audit for privileged changes.
