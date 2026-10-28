# 01 – PDF-to-code gap analysis

Source of the target: `printout_buddy_schema.pdf` (23 pages, "Database Schema, API and Business Logic"). Source of the as-is: `origin/main` at `080c6bd` (`apps/api/prisma/schema.prisma`, 113 registered routes, see `docs/architecture/api-inventory.md` on PR #44).

Status vocabulary: EXACT_MATCH, PARTIALLY_IMPLEMENTED, MISSING, CONFLICTS_WITH_CURRENT_SYSTEM (C), LEGACY_FEATURE_TO_PRESERVE (L), UNSPECIFIED_OR_AMBIGUOUS (U).

**Headline finding.** The PDF describes a *customer marketplace* (accounts, discovery, geo search, ordering by authenticated customers, reviews, UPI tracking, 7-day file retention). The repository is a *shop-side print queue* with guest QR ordering. Only the shop-owner side, Firebase identity, FCM, audit and some pricing/order concepts overlap. There is **no customer account, no geo data, no PostGIS, no review, no payment tracking and no customer notification** in code today.

## 1. Tech stack (PDF p1)

| Item | PDF | Current | Status |
|---|---|---|---|
| Login | Firebase Auth, ID token on every API call | Firebase used only for Google/phone exchange at `POST /auth` and web equivalents; API uses its own access + rotating refresh tokens (`routes/auth-mobile.ts`, `auth-refresh.ts`); ID token is rejected by all other routes | C (by design, see 06) |
| Push | FCM | `FcmRegistration` (token AES-GCM encrypted), `notifications/fcm.ts` | PARTIALLY_IMPLEMENTED (shop owners only) |
| File storage | Cloudflare R2 private | `apps/api/src/storage/*` driver abstraction (local + S3-compatible) | PARTIALLY_IMPLEMENTED (confirm production driver) |
| Database | PostgreSQL + PostGIS | PostgreSQL; no PostGIS (no migration, no code) | MISSING |
| Backend | Node/TS | Fastify/TS | EXACT_MATCH |
| Signed URLs 2-5 min | Download URL 2-5 min | HMAC signed URL for local driver; shop document access via authenticated route | PARTIALLY_IMPLEMENTED |

## 2. Entities (11 PDF tables)

Current schema: 32 Prisma models and 14 enums (`grep -c '^model '` on `schema.prisma`). Most overlap is with the shop-owner side.

| # | PDF table | Current model | Status | Gap |
|---|---|---|---|---|
| 1 | users | `User` | C/PARTIAL | Role is a single enum `SHOP_OWNER|PLATFORM_ADMIN`; no `customer`; no multi-role array; email required+unique, no phone/name split, no `phoneNumber` on User (phone is in `UserPhoneIdentity`), no referral, no address/location, no `isActive` (blocking is via `Shop.status`), `passwordHash` required. Firebase uid lives in identity tables, not `User.firebaseUid`. |
| 2 | userFcmTokens | `FcmRegistration` | PARTIAL | Same concept; keyed `(userId, installationId)`, encrypted token + hash (stronger than PDF). Platform values already android/ios/web. No customer use yet. |
| 3 | shops | `Shop` + `ShopSettings` | PARTIAL | Missing: ownerId (via `User.shopId`/`Membership`), phone, email, structured address (only `address`, `pincode`), city/state/country, `location` geography, isVerified/verifiedAt/verifiedBy, isOpen (hours engine computes it), isActive (`ShopStatus`), upiId, acceptedPaymentMethods, showQr, qrCodeUrl, profilePhoto, ratingAvg/ratingCount. |
| 4 | shopRates | `PricingRule` | C | Per **sheet**, keyed by paperSize x colour x sides. PDF is per **page** x printingType. Not interchangeable (see 02, 04). |
| 5 | shopPaperOptions | none (`PricingRule.paperSize` implies sizes) | MISSING | No paperType concept anywhere. |
| 6 | shopImages | none | MISSING | |
| 7 | orders | `Order` + `Document` | PARTIAL/C | See section 3. |
| 8 | orderStatusHistory | `OrderStatusHistory` | PARTIAL | Has from/to/reason/actor user or device. Statuses differ. `changedBy` in PDF is a user id only. |
| 9 | reviews | none | MISSING | |
| 10 | notifications | `ShopNotification` | PARTIAL | Shop-scoped, outbox-like, seq-ordered, SSE. PDF is per-user (customers too). |
| 11 | auditLogs | `AuditLog` | PARTIAL | Has actor/action/target/metadata. PDF's `before`/`after` jsonb would be carried in `metadata`; append-only not enforced (open decision 4 in SCHEMA_ALIGNMENT.md). |

## 3. Enums

| PDF enum | PDF values | Current | Status |
|---|---|---|---|
| userRole | customer, shopOwner, admin | `Role`: SHOP_OWNER, PLATFORM_ADMIN | PARTIAL: `CUSTOMER` missing; naming differs (map, do not rename). |
| printingType | colored, blackWhite | `ColourMode`: bw, colour (+ `PrintSides`) | C: spelling and a missing sides dimension. |
| orderStatus | pending, accepted, printing, ready, completed, rejected, cancelled | `OrderStatus`: NEW, ACCEPTED, PRINTING, PRINTED, READY, COLLECTED, CANCELLED, EXPIRED | C: no REJECTED (D7 adds it); extra PRINTED/EXPIRED; COLLECTED ~ completed. Cancel is currently shop-side. |
| paymentMethod | cash, upi | none | MISSING |
| paymentStatus | unpaid, pendingVerification, paid, refunded | none (`Payment.status` is free text, unused, platform billing) | MISSING |

## 4. Order columns (PDF p5) vs `Order`/`Document`

| PDF field | Current | Status |
|---|---|---|
| id, createdAt, updatedAt | present (cuid, not uuid) | EXACT_MATCH (id type differs: keep cuid) |
| orderNumber unique `PB-YYYYMMDD-####` | `orderNumber` unique per shop (`@@unique([shopId, orderNumber])`), per-shop counter, format differs | PARTIAL: global uniqueness is not required by code |
| customerId | none (guest; `customerDisplayNameOrReference` free text) | MISSING |
| shopId | present | EXACT_MATCH |
| ownerId (denormalised) | not needed today (shop-scoped) | MISSING |
| fileKey/fileName/fileContentType/fileSizeBytes/pages | `Document.objectKey, originalFilename, detectedMimeType, byteSize, pageCount` | PARTIAL (join through `documentId`) |
| fileDeletedAt | `Document.deletedAt` | PARTIAL |
| printingType, paperSize, paperType, copies, note | inside `printOptionsSnapshot` JSON (colour, sides, copies, paper size; no paperType, no note) | PARTIAL |
| pricePerPagePaise, totalPages, totalPaise | `priceSnapshot` JSON (per-sheet), `totalPaise` | C for per-page; totalPaise EXACT_MATCH |
| paymentMethod/paymentStatus/upiTxnRef | none | MISSING |
| status | `OrderStatus` | C |
| rejectReason/cancelReason | `OrderStatusHistory.reason` | PARTIAL |
| isReviewed, acceptedAt, completedAt | none (derivable from history) | MISSING/derivable |
| Idempotency-Key header | `clientRequestId` unique per shop | PARTIAL |
| Server-authoritative price | quote-token + server pricing (`domain/pricing.ts`, `quote-token.ts`) | EXACT_MATCH (concept) |

## 5. API endpoints (PDF p7-19)

Current labels: LIVE = same contract, DIFF = route exists with different contract, NEW = absent. Full mapping in `05-api-contract-mapping.md`.

| PDF endpoint | Current | Status |
|---|---|---|
| POST /auth/login (Firebase idToken in body) | `POST /auth` (mobile), `/auth/firebase/exchange`, `/auth/google/session`, `/auth/phone/session`, `/auth/login` | DIFF (C: different token model) |
| GET /me, PATCH /me | `GET/PATCH /users/me` | DIFF |
| PUT/DELETE /me/fcm-token | `PUT/DELETE /users/me/fcm-token` | DIFF (path, owner only) |
| GET /shops/nearby | none | MISSING |
| GET /shops/{id} | `GET /public/shops/:slug` (slug, no auth) | DIFF |
| GET /shops/{id}/reviews | none | MISSING |
| POST /uploads/presign | `uploads/initiate` + upload PUT (HMAC token, 15 min) | DIFF |
| POST /orders, GET /orders, GET /orders/{id}, GET /orders/{id}/file, POST cancel, POST payment | `POST /public/shops/:slug/orders`, `GET /public/orders/:token` | DIFF (guest, tracking-token capability) |
| POST /reviews | none | MISSING |
| GET /shops/mine | `GET /shops/me` (single shop) | DIFF |
| PATCH /shops/{id} | `PATCH /shops/me`, `PUT /shop/settings` | DIFF |
| PUT .../rates | `/shop/pricing-rules` CRUD | DIFF (per sheet) |
| PUT .../paper-options, POST .../images | none | MISSING |
| GET /shops/{id}/orders, PATCH .../status | `/shop/orders*` (+ print-now, device order routes) | DIFF (different statuses, no reject) |
| PATCH .../payment | none | MISSING |
| POST/GET /admin/shops, PATCH verify/block | `POST/GET/PUT /admin/shops`, `/admin/shops/:id` (status via PUT) | PARTIAL/DIFF |

Route methods missing from current code: nearby, reviews x2, presign (as specified), customer orders x6, images, paper-options, payment x2, verify, block = **~20 of 33 PDF operations are NEW**; ~13 have a differing live equivalent; **0 are EXACT_MATCH** (paths, auth and envelopes differ: PDF errors are flat `{code,message,details}`, current is `{error:{code,message,requestId,details}}`; success bodies are un-enveloped in the PDF, enveloped `{data}` here; pagination `{items,page,limit,total}` is not the current shape either).

## 6. Business rules

| Rule | Status |
|---|---|
| Login claims admin-created owner by phone match | C: current rules forbid auto-link by matching phone/email (explicit, re-authenticated linking only). Do **not** implement. |
| New user gets `customer`, referral codes | MISSING (referral is an unspecified growth feature; defer) |
| Nearby: verified, active, ST_DWithin, sort distance then rating, closed listed | MISSING |
| Order create checks order (closed, rate, paper, payment, file HEAD, key prefix `uploads/{userId}/`, server page count, copies 1-50, idempotency) | PARTIAL: closed (hours engine), rate, document validation, page count (`pdf/`), idempotency exist; paper type, payment, copies cap and user-scoped key prefix do not |
| Status flow + actors + history + FCM push | PARTIAL/C (see 08) |
| 30-minute pending auto-cancel | U (optional in PDF); current has EXPIRED via worker for unprinted docs |
| Cash/UPI, UTR uniqueness per shop, refunds admin-only | MISSING |
| Reviews transactional with rating recompute | MISSING |
| Verification, block, audit | PARTIAL (`PUT /admin/shops/:id` status, AuditLog) |
| Rates: replace set in a transaction; need >=1 rate before open | PARTIAL |
| Admin create: reuse user by phone | C (same linking rule) |
| File lifecycle: orphan 24h, 7-day post-order delete, 2-5 min signed URL | C/PARTIAL: orphan cleanup 24h (`UNPRINTED_RETENTION_HOURS=24`) matches; **post-print retention is 30 min (`PRINT_RETENTION_MINUTES=30`) vs 7 days** (privacy decision, see 09) |
| FCM: after commit, delete UNREGISTERED tokens | PARTIAL (`failureCount`, revocation) |
| Rate limits (login 10/min, presign 50/h) | PARTIAL (login 10/min exists; no presign hourly quota) |
| UTC storage, IST display | EXACT_MATCH |

## 7. Indexes (PDF p23)

| Index | Status |
|---|---|
| users phone/email/referral/firebaseUid unique | PARTIAL (email unique; uid and phone unique in identity tables) |
| shops ownerId, GiST location, flags | MISSING |
| shopRates (shopId, printingType) | C (`PricingRule` unique differs) |
| orders (shopId,status,createdAt) | EXACT_MATCH |
| orders customerId/ownerId/upiTxnRef-shopId | MISSING |
| reviews, userFcmTokens token unique | MISSING / EXACT_MATCH (`tokenHash` unique) |

## 8. Legacy features not in the PDF (LEGACY_FEATURE_TO_PRESERVE)

Guest QR ordering and tracking tokens; quote tokens; `CustomerSession`; owner password, Google and phone sign-in; Admin TOTP 2FA and recovery codes; `PhoneOnboardingGrant`; web cookie+CSRF sessions; mobile refresh rotation; `ShopSettings` hours/timezone/closures/AfterHoursPolicy; `ShopDevice`/`DevicePairingCode`/`DevicePrinter`/`DevicePrintJob` (Android/Windows print path); `PrintAgent`/`Printer`/`PrintJob` (unused additive tables); `Plan`/`Subscription`/`Invoice`/`Payment` (billing, dormant; shops are free); `ShopNotification` + SSE; revenue estimate report; QR poster; History/CSV.

## 9. Coverage (honest estimate)

Counting the 11 tables, 5 enums and 33 operations as 49 items, a rough hand tally gives: a handful EXACT_MATCH (UTC rule, backend stack, `orders(shopId,status,createdAt)` index, `totalPaise`), about 18 PARTIAL, about 20 MISSING and about 8 CONFLICT. **Roughly 40% of PDF requirements have a usable foundation in code; ~0% of the customer-facing contract is live.** These counts are judgement-based, not mechanically derived.

## 10. UNSPECIFIED_OR_AMBIGUOUS in the PDF

- Order status/"Windows agent" interplay is not described at all.
- `Shop.isVerified` vs the free self-signup that already produces an immediately ACTIVE shop.
- Whether `ratingAvg` rounds or truncates (`numeric(2,1)`).
- "Pages x copies" for duplex; PDF has no sides.
- `reviews.shopId` and `orders.ownerId` denormalisation when a shop changes owner.
- PDF mixes `shop_*` camelCase table names with the repo's PascalCase Prisma models; no physical rename is needed.
- Referral reward is undefined; whether `customer` and `shopOwner` roles may share one login identity is undefined.
- GET /orders/{id}/file for shop owners vs the existing document access rules.
- PDF API examples show `shp_...` ids, existing ids are cuid.
