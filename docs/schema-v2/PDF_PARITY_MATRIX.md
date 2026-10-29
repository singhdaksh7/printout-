# Printout Buddy PDF Contract Parity Matrix

Generated from `C:\Users\daksh\OneDrive\Desktop\printout_buddy_schema.pdf` on 2026-10-29. The source has 23 pages; SHA-256: `A1D3896CFCDD67B0E6C152E6304B2D2059C3D4F34D4B4088F6766F999B48B6A7`.

Status vocabulary: `EXACT`, `COMPATIBLE_ADAPTER`, `DIFFERENT`, `BLOCKED`, `NOT_IMPLEMENTED`, `DEPLOYED_VERIFIED`.

This matrix is intentionally strict. Existing Schema V2 documentation is not treated as proof of PDF compliance. Production observations are from the read-only deployment inspection recorded in `FULL_IMPLEMENTATION_AUDIT.md`; production currently runs commit `46f2322a36f3aa057b7f39adb61f35fa01943cb3` and does not include this branch.

## Contract and policy differences

| Page | Requirement | PDF exact value | Current value | Difference | Required fix | Test / deployment status |
|---|---|---|---|---|---|---|
| 1, 22 | File bucket | Private Cloudflare R2 | S3-compatible private driver | COMPATIBLE_ADAPTER | Verify production endpoint and bucket policy | Production driver configured; access behavior not fully verified |
| 1, 22 | File deletion | 7 days after completed/cancelled/rejected; orphan 24h | Approved project policy is 30-minute retention; stale upload cleanup exists | DIFFERENT | Owner must resolve policy conflict; add 7-day configuration only after privacy/recovery review | BLOCKED from activation |
| 2 | Roles | `customer`, `shopOwner`, `admin`; `roles` array | Prisma single role plus `UserRoleGrant`; API role strings | COMPATIBLE_ADAPTER | Keep compatibility mapping; no unsafe client role acceptance | Branch tests pass; production old release |
| 7 | Auth header | Firebase ID token on every call | App-issued access bearer + rotating refresh token | DIFFERENT | Document and maintain secure exchange boundary; add PDF endpoint adapters only where safe | PDF `/auth/login` adapter implemented locally/PR |
| 8 | Login response | Creates user immediately; `isNewUser` | New customer enters gated onboarding before account creation | DIFFERENT | Decide whether to add safe null-name customer creation; do not silently bypass onboarding policy | BLOCKED by existing approved onboarding policy |
| 20 | Firebase login | Match by UID; PDF also permits phone claim and new customer creation | UID-only for linked identities; no email/phone linking; restricted onboarding | COMPATIBLE_ADAPTER | Preserve no-linking security and document deviation | Automated Firebase emulator tests pass |
| 20 | Referral | Applied only to newly-created user | PDF adapter accepts but does not apply referral yet | DIFFERENT | Implement referral assignment when safe customer creation path is approved | NOT_IMPLEMENTED |
| 12, 21 | Upload maximum | 20 MB | 50 MiB approved project policy | DIFFERENT | Resolve explicit policy conflict and change config/UI together | BLOCKED |
| 12 | Upload route | `POST /uploads/presign` | `POST /customer/uploads` | COMPATIBLE_ADAPTER | Add exact route adapter with PDF request/response shape | NOT_IMPLEMENTED |
| 20 | Price | `pricePerPagePaise * pages * copies` | Existing print flow uses per-sheet/duplex policy in places | DIFFERENT | Add dedicated PDF rate adapter or visibly reject incompatible duplex pricing | Partially tested; needs parity tests |
| 23 | Free phase | No subscription/plan tables | Existing operational subscription tables | DIFFERENT | Keep legacy tables for production; exclude them from PDF business contract | Documented compatibility |

## Database entities

| Page | Entity | PDF target | Current schema/source | Difference | Required fix | Status |
|---|---|---|---|---|---|---|
| 2 | users | `firebaseUid`, roles array, nullable email, profile/location/referral fields | `User`, `UserRoleGrant`, Firebase identity tables, customer profile fields | COMPATIBLE_ADAPTER | Add/verify exact projection and indexes; do not duplicate identity data unsafely | TESTED_ON_BRANCH |
| 2 | userFcmTokens | standalone token, unique token, platform, created/lastSeen | `FcmRegistration`, encrypted token + hash, installation binding | COMPATIBLE_ADAPTER | Expose PDF token API using encrypted storage | NOT_IMPLEMENTED |
| 3 | shops | owner, address, PostGIS location, verification/open/active/payment/rating fields | `Shop` plus settings/rates/images/subscription | COMPATIBLE_ADAPTER | Add exact public projection and verify PostGIS production readiness | PARTIAL |
| 3 | shopRates | one row/type, `pricePerPagePaise` | `ShopRate` with current pricing fields | DIFFERENT | Add per-page compatible rate field/model without relabeling sheets | PARTIAL |
| 4 | shopPaperOptions | kind/value unique | Existing paper option model/route | COMPATIBLE_ADAPTER | Exact PDF replacement request/response | PARTIAL |
| 4 | shopImages | R2 image key/sort order | Existing shop image model and signed route | COMPATIBLE_ADAPTER | Exact PDF upload route and URL projection | PARTIAL |
| 5 | orders | `customerId`, ownerId, file key, page pricing, PDF enums | Existing `Order` with customer/owner compatibility fields and document relation | COMPATIBLE_ADAPTER | Exact PDF field aliases and integer-price semantics | PARTIAL |
| 5 | orderStatusHistory | append-only `changedBy` | Existing history plus actor/device fields | COMPATIBLE_ADAPTER | Exact response projection | TESTED_ON_BRANCH |
| 6 | reviews | unique order, 1–5 check, rating aggregation | `Review` and shop aggregation logic | COMPATIBLE_ADAPTER | Exact PDF route `/reviews` | PARTIAL |
| 6 | notifications | `notifications`, types orderStatus/verification | Customer and shop notification tables | DIFFERENT | Add PDF projection; retain durable encrypted FCM implementation | PARTIAL |
| 6 | auditLogs | actor/action/target/before/after append-only | `AuditLog` richer actor model | COMPATIBLE_ADAPTER | Exact PDF admin projection | TESTED_ON_BRANCH |

## API endpoint parity

| Page | PDF endpoint | Current backend endpoint | Request/response difference | Required fix | Status |
|---|---|---|---|---|---|
| 8 | `POST /auth/login` | Same path; email/password plus new Firebase dispatcher | PDF Firebase adapter returns app bearer pair and onboarding state; Firebase token is exchange-only | Keep both contracts; complete new-user/referral parity safely | COMPATIBLE_ADAPTER |
| 9 | `GET /me` | `GET /users/me` / profile routes | Path and response differ | Add exact `/me` projection | NOT_IMPLEMENTED |
| 9 | `PATCH /me` | `PATCH /customers/me` / profile routes | Path and field projection differ | Add exact adapter preserving authorization | NOT_IMPLEMENTED |
| 9 | `PUT /me/fcm-token` | Existing profile FCM route | Exact route/request shape not exposed | Add adapter | NOT_IMPLEMENTED |
| 9 | `DELETE /me/fcm-token` | Existing token delete route | Exact query contract not exposed | Add adapter | NOT_IMPLEMENTED |
| 10 | `GET /shops/nearby` | `GET /customer/shops/nearby` | Prefix and response projection differ | Add exact adapter; verify PostGIS/fallback | NOT_IMPLEMENTED |
| 10 | `GET /shops/{shopId}` | `GET /customer/shops/{shopId}` | Prefix and response fields differ | Add exact adapter | NOT_IMPLEMENTED |
| 11 | `GET /shops/{shopId}/reviews` | `GET /customer/shops/{shopId}/reviews` | Prefix/response wrapper differ | Add exact adapter | NOT_IMPLEMENTED |
| 11 | `POST /uploads/presign` | `POST /customer/uploads` | Body uses `contentType,sizeBytes`; current uses declared MIME/document workflow | Add secure exact adapter with 20 MB policy decision | NOT_IMPLEMENTED |
| 12 | `POST /orders` | `POST /customer/orders` after quote | PDF sends order fields directly; current quote-first flow | Add quote-backed compatibility adapter; never trust client price | NOT_IMPLEMENTED |
| 13 | `GET /orders` | `GET /customer/orders` | Prefix/field projection differ | Add exact adapter | NOT_IMPLEMENTED |
| 13 | `GET /orders/{orderId}` | `GET /customer/orders/{id}` | Prefix/response projection differ | Add exact adapter | NOT_IMPLEMENTED |
| 13 | `GET /orders/{orderId}/file` | Existing customer/shop document access route | Prefix/response field differ | Add signed URL adapter; preserve privacy | NOT_IMPLEMENTED |
| 14 | `POST /orders/{orderId}/cancel` | `POST /customer/orders/{id}/cancel` | Prefix/response differ | Add exact adapter | NOT_IMPLEMENTED |
| 14 | `POST /orders/{orderId}/payment` | `POST /customer/orders/{id}/payment` | Prefix/response differ | Add exact adapter | NOT_IMPLEMENTED |
| 14 | `POST /reviews` | `POST /customer/reviews` | Prefix/response differ | Add exact adapter | NOT_IMPLEMENTED |
| 15 | `GET /shops/mine` | `GET /shops/mine` | Current response is not exact PDF pagination/projection | Align response adapter | PARTIAL |
| 15 | `PATCH /shops/{shopId}` | Existing shop profile routes | Path/field projection differ | Add exact adapter | NOT_IMPLEMENTED |
| 16 | `PUT /shops/{shopId}/rates` | Existing shop rate route | Likely compatible but exact response needs verification | Add contract tests | PARTIAL |
| 16 | `PUT /shops/{shopId}/paper-options` | Existing shop paper route | Likely compatible but exact response needs verification | Add contract tests | PARTIAL |
| 16 | `POST /shops/{shopId}/images` | Existing shop image route | Upload/response projection differs | Add exact adapter | PARTIAL |
| 17 | `GET /shops/{shopId}/orders` | Existing shop order routes | Path/response projection differs | Add exact adapter | PARTIAL |
| 17 | `PATCH /shops/{shopId}/orders/{orderId}/status` | Existing shop status route | Status compatibility exists; PDF exact body/errors need adapter | Add contract tests/adapter | PARTIAL |
| 18 | `PATCH /shops/{shopId}/orders/{orderId}/payment` | Existing payment route | Status semantics differ in response/error names | Add exact adapter | PARTIAL |
| 18–19 | Admin shop routes | Existing admin routes | Exact request/response/audit projection needs parity | Add exact adapters | PARTIAL |

## Business rules and indexes

| Page | Rule | Current value | Required fix | Status |
|---|---|---|---|---|
| 20 | Verify Firebase Admin token with revocation | Firebase Admin verifier; production revocation setting requires verification | Confirm production `checkRevoked` policy and real token smoke | DEPLOYED_UNVERIFIED |
| 20 | New user receives customer role immediately | Restricted onboarding gate | Resolve policy difference | DIFFERENT |
| 20 | Phone claim can claim admin-created owner | Existing security policy forbids phone/email linking | Preserve secure policy; document as intentional conflict | COMPATIBLE_ADAPTER |
| 21 | Idempotency-Key header | Existing clientRequestId/quote idempotency | Add header adapter and tests | PARTIAL |
| 21 | Server re-counts PDF pages | Existing server document verification | Verify against exact PDF endpoint | TESTED_ON_BRANCH |
| 21 | `totalPages = pages * copies` and integer paise | Implemented in customer quote/order path | Add PDF per-page adapter tests | PARTIAL |
| 21 | Status transition graph | Existing lifecycle with rejection flag and history | Compare all transitions/error codes exactly | PARTIAL |
| 22 | Orphan 24h and ended-order 7d cleanup | Current approved 30-minute policy | Resolve explicit conflict before production change | BLOCKED |
| 22 | FCM after commit and unregister cleanup | Durable notification paths; token cleanup needs endpoint/provider evidence | Add contract/provider regression tests | PARTIAL |
| 23 | Required indexes | Many operational indexes exist | Compare generated Prisma SQL/indexes and add safe additive indexes | PARTIAL |

## Immediate implementation order

1. Merge and deploy PR #60 only after CI passes; this fixes the waiting mobile PDF-shaped Firebase login without breaking email/password or admin 2FA.
2. Add exact `/me`, shop, upload, order, payment and review route adapters with contract tests, backed by the existing secure bearer session.
3. Resolve the explicit 20 MB versus 50 MiB and 7-day versus 30-minute retention policies before changing production configuration.
4. Add the PDF per-page pricing model/adapter and idempotency-header compatibility.
5. Add exact database/API projections, then run staging and production smoke tests.

The PDF compliance percentage is not claimed here: the route and schema differences above include `DIFFERENT`, `PARTIAL`, and `NOT_IMPLEMENTED` items, and production has not yet received this branch.
