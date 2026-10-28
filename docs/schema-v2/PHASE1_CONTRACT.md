# Phase 1 contract: identity and multi-shop

Status of every item below: **IMPLEMENTED on branch `feature/daksh-schema-v2-phase1-identity`; becomes CURRENT_PRODUCTION only when `IMPLEMENTATION_PROGRESS.md` says DEPLOYED with evidence.** All routes are additive; no existing response shape or route changed.

## Compatibility rules (Android and web)

- `POST /auth` gains an **optional** body field `audience`: `"shop"` (default, identical to today) or `"customer"`. The existing owner app never sends it, so its behaviour is unchanged. A customer identity signing in without `audience: "customer"` still gets the existing `403 FORBIDDEN`; an owner identity with `audience: "customer"` gets `403 FORBIDDEN`. `loginMethod: "email"` with `audience: "customer"` is `400`.
- New response values (only ever returned to customer accounts or `audience: "customer"` requests): `user.role = "customer"`; `nextStep = "create_customer"` (restricted grant, call `POST /customers/onboarding`) or `"customer_home"`. `user.email` may be `null` for customers.
- The existing owner contract (`nextStep` values `dashboard`, `complete_profile`, `create_shop`, `generate_qr`, `account_blocked`, `shops` of length 0 or 1, `/shops/me`) is unchanged. `/shops/mine` is additional.
- Customer sessions use the same bearer/refresh mechanics as owners (`/auth/refresh`, `/auth/logout`).

## New routes

| Route | Auth | Notes |
|---|---|---|
| `POST /customers/onboarding` | restricted onboarding grant (bearer for mobile, cookie for web) | Body `{ name, client, deviceId? }`, strict. Flag `CUSTOMER_SIGNUP_ENABLED` (default off, else `403 CUSTOMER_SIGNUP_DISABLED`). `201` created / `200` idempotent retry; `409 ALREADY_ONBOARDED`, `409 PHONE_UNAVAILABLE` / `GOOGLE_IDENTITY_UNAVAILABLE`. Creates a `CUSTOMER` user (no password, no shop) + `UserRoleGrant` + verified identity in one transaction. If the Google email already belongs to another account the customer is created with `email = null`; nothing is merged or revealed. |
| `GET /customers/me` | customer session | The standard profile (`role: "customer"`, `shops: []`) plus `customer: { addressLine1, addressLine2, city, state, pincode, latitude, longitude }`. |
| `PATCH /customers/me` | customer session | Strict body: `name`, address fields, `pincode` (6 digits), `latitude`+`longitude` (sent together, valid ranges). Unknown keys (role, isActive, shopId, email) are `400`. Audited by field name only. |
| `GET /shops/mine` | owner session | `{ data: { items: [{ id, slug, shopName, shopStatus, isActive, acceptsOrders, isDefault, createdAt }], page, limit, total, defaultShopId } }`. The default shop (`User.shopId`) plus shops where the caller has an `OWNER` membership. `STAFF` memberships and other tenants never appear. |

## Authorization model

- `User.role` stays the primary role used by guards. `UserRoleGrant` records roles (backfilled; new owners and customers get a row). Grants never confer access by themselves and the API never creates `PLATFORM_ADMIN` grants.
- Customers: `customerGuard` (CUSTOMER role only). Owner routes (`shopGuard`) and admin routes (`adminGuard`) already require their own role, so customers are refused (403) everywhere else.
- `requireOwnedShop(userId, shopId)` is the single check for future `/shops/{shopId}/...` routes: unknown and foreign shops are both `404`.
- `User.isActive = false` blocks the account (`403 ACCOUNT_BLOCKED`) on use, sign-in and refresh.
- Identity is resolved only by Firebase uid. Matching email or phone never links, signs in or merges accounts (AD-6).

## Database (migrations `20261028100000_customer_role_enum`, `20261028100100_customer_identity_foundation`)

Additive only: `Role` + `CUSTOMER`; `User.email` nullable with `CHECK (role = 'CUSTOMER' OR email IS NOT NULL)`, `CHECK (role <> 'CUSTOMER' OR shopId IS NULL)`, coordinate range and pairing checks; customer address, coordinates and `isActive` columns; `UserRoleGrant` table; restartable backfill of one grant per user and an `OWNER` membership per owner's default shop. Verified on a disposable PostgreSQL 16 upgrade with seeded data (counts unchanged, backfill correct, constraints enforced, `prisma migrate diff` clean). Rollback: application code ignores the new objects; the enum value cannot be removed.

## Android notes

Existing owner app: no change required. Customer app (not in this repository): send `audience: "customer"` on `POST /auth`; if `nextStep == "create_customer"` call `POST /customers/onboarding` with the restricted access token, then use the returned pair like an owner pair.
