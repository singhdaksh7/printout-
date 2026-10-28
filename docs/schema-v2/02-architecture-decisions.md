# 02 – Architecture decisions

Status vocabulary: **PROPOSED** (suggested by the architecture work), **APPROVED** (historical label, superseded: every row below is now APPROVED), **APPROVED** (owner confirmed), **BLOCKED**, **SUPERSEDED**.

**Owner approval recorded 2026-10-28** (one-time authorization in the project conversation): D1-D8, AD-3, AD-6, admin-only manual refunds and the 50 MiB upload limit are APPROVED and FINAL for this implementation. Implementation status is tracked in `IMPLEMENTATION_PROGRESS.md`.

## A. Decision register (owner preferences, awaiting confirmation)

| # | Topic | Recorded preference | Status | Dependencies and conflicts | Preserved production behaviour |
|---|---|---|---|---|---|
| D1 | Product scope | Full customer + shop-owner marketplace | APPROVED | Needs customer role, discovery, ordering, reviews, payments and notifications; delivered in phases 1-6 (11). Large: no phase may be skipped or merged into one PR. | Guest QR ordering, owner dashboard and Windows/Android print path keep working. |
| D2 | Pricing | Keep per-sheet calculation, including correct duplex. Customers see clear, server-authoritative quotes | APPROVED | Conflicts with PDF `shopRates` (per page x printingType) and with `PDF orders.pricePerPagePaise/totalPages`. Resolved by: PDF fields are API *projections* only; stored price stays `PricingRule.pricePerSheetPaise` and `Order.priceSnapshot`. Duplex: one sheet = two pages. Quote must come from the existing quote-token path; any client amount is ignored. | `POST /public/shops/:slug/quotes` and order creation unchanged. |
| D3 | Retention | Keep 30 min after print and 24 h for unprinted; no 7-day retention without separate approval | APPROVED | Conflicts with PDF 7-day rule and with `GET /orders/{id}/file` for customers. Consequence: the customer file re-download endpoint is **BLOCKED** (not offered) while 30 minutes stands. Upload cap stays 50 MiB (PDF says 20 MB; separate config decision). | `PRINT_RETENTION_MINUTES=30`, `UNPRINTED_RETENTION_HOURS=24`. |
| D4 | PostGIS | Approved in principle for nearby search, subject to non-production testing and migration review | APPROVED | Production permission to `CREATE EXTENSION postgis` is **unverified** (BLOCKED until checked). Plan: test on a disposable PostGIS-enabled database; migration is its own reviewed PR; nearby search is designed behind a repository interface with a haversine fallback so Phase 2 is not hard-blocked. Docker image used by `docker-compose.yml` / CI must support PostGIS or tests need a separate image. | No production DB change. |
| D5 | Customer email | Permit nullable email if verified identity architecture supports it securely | APPROVED | `User.email` and `passwordHash` are required today. Security condition: a customer is identified by the verified Firebase uid (identity tables), never by email; no linking by email or phone equality; owner and admin accounts keep non-null email and password rules (enforce with a check constraint: nullable email only when role is CUSTOMER). Needs an audit of every `user.email` consumer first. | Owner password/Google/phone sign-in unchanged. |
| D6 | Payments | Customer-to-shop cash/UPI tracking in v1; no automatic processing; no platform subscription billing | APPROVED | New `OrderPayment`; UTR is an unverified claim; only the shop sets `paid`; refund permission undefined (proposed admin-only, **open**). Dormant platform `Payment`/`Invoice`/`Subscription` are untouched. Revenue report remains "estimated order value"; do not relabel it as collected revenue until verified payment data exists. | Shops stay free. |
| D7 | Rejected state | Distinct `REJECTED` via additive, compatibility-tested lifecycle migration | APPROVED | Supersedes the earlier proposal to map reject to CANCELLED (see 08). Risk: Android, web queue, tracking page, analytics, history/CSV, worker cleanup and Windows Agent switch on `OrderStatus`; each must tolerate an unknown value before the enum value is used. Rollout: (1) release clients that tolerate unknown statuses, (2) add enum value, (3) enable shop reject action behind a flag. `ALTER TYPE ADD VALUE` is irreversible. | Existing statuses and the cancel-only live flow unchanged until step 3. |
| D8 | Referrals | Deferred from MVP; future scope | APPROVED | PDF `referralCode`, `referredByUserId` and login referral logic are **not** built; no columns added now. | none |

## B. Architecture decisions (proposed by this work)

| ID | Decision | Status | Rationale |
|---|---|---|---|
| AD-1 | PDF = product target; repository = infrastructure authority. No literal adoption of the 11-table schema. | PROPOSED | Existing sessions, devices, 2FA, hours, print path and billing have no PDF equivalent. |
| AD-2 | Keep Prisma names; map PDF names in 04. No table renames. | PROPOSED | Renames break clients and history. |
| AD-3 | Keep the app's access + rotating refresh tokens; Firebase ID tokens are exchanged once at `POST /auth`. The PDF's "ID token on every call" is not adopted. | APPROVED | Revocation, device binding, replay protection and 2FA depend on it (06). |
| AD-4 | Add `CUSTOMER` to `Role` (additive) and `UserRoleGrant` for multi-role; do not change `User.role` to an array. | PROPOSED | `User.role` is a scalar used by guards. |
| AD-6 | No automatic identity linking by email/phone. The PDF's "claim by phone" login step and "reuse user by phone" on admin create are rejected. | APPROVED | Existing security rule. |
| AD-7 | Multi-shop via `Membership`; `User.shopId` stays as default/legacy shop; shop id is a path parameter always checked against membership. | PROPOSED | No caller-controlled tenant switching. |
| AD-9 | `Shop.isVerified` is a separate additive flag from `ShopStatus` and `Subscription`; existing ACTIVE shops are backfilled verified. | PROPOSED | Preserves free signup. |
| AD-12 | Customer ordering reuses existing pricing/validation; guest QR flow untouched; authenticated orders add nullable `customerUserId`. | PROPOSED | |
| AD-15 | New customer routes additive under `/api/v1/customer/...`; multi-shop owner routes under `/api/v1/shops/{shopId}/...`; existing routes never repurposed. | PROPOSED | |
| AD-16 | Envelopes stay `{data}` / `{error:{...}}`; the PDF's flat error shape is not adopted. | PROPOSED | Android parses it. |
| AD-17 | Windows Agent, `DevicePrintJob` and Phase B are untouched until `feature/daksh-phase-b-smart-print-printers` is merged or coordinated. | PROPOSED | |

(AD-5, AD-8, AD-10, AD-11, AD-13, AD-14 from the first draft are superseded by D5, D2, D4, D7, D6, D3 respectively.)

## C. Unresolved dependencies and conflicts

| Item | State |
|---|---|
| PostGIS on production | APPROVED for implementation; enable only after extension/privilege/backup/performance checks pass; otherwise the application-level fallback ships and PostGIS stays pending |
| Refund permission | RESOLVED: admin-only manual refund recording, no automatic money movement |
| Customer app token flow (AD-3) | RESOLVED: existing access/refresh model |
| Nullable-email consumer audit | required before the Phase 1 migration (in progress) |
| Phase B overlap (printers/device jobs) | coordinate with Antigravity before Phase 4 |
| Upload cap | RESOLVED: keep 50 MiB |
| Branch base for PR #45 and the skill PR | see 12 / PR notes: `development` is behind `main` |
| PDF itself is not committed to the repository | obtain from the owner; references cite it by filename |
