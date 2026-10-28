# 07 – Migration plan (proposed; nothing applied)

Strategy: expand, migrate, verify, contract. This release only expands. No drops, no renames, no retyping, no resets. Applied migrations are never edited.

| Step | Migration (new, forward-only) | Backfill | Verification |
|---|---|---|---|
| M1 identity | `Role` + `CUSTOMER`; `User.email` nullable (with partial unique); `User` address, lat/lng, `isActive` default true; `UserRoleGrant` | one grant per user from `User.role` | row counts, `migrate diff` clean |
| M2 shop profile | `Shop` new nullable columns; `isVerified` default false | set `isVerified=true`, `verifiedAt=now()` for all existing ACTIVE shops so none leaves discovery | no ACTIVE shop unverified after backfill |
| M3 shop media/paper | `ShopPaperOption`, `ShopImage` | seed paperSize from distinct `PricingRule.paperSize` | counts match |
| M4 geo | btree index on `(latitude, longitude)` and `(isVerified, status)`. PostGIS (`CREATE EXTENSION`, `geography`, GiST) is a **separate, later** migration gated on **[APPROVAL]** and a permission check (`SELECT * FROM pg_available_extensions WHERE name='postgis'`; operator may need superuser or a provider toggle) | derive geography from lat/lng | EXPLAIN on nearby query |
| M5 order | `Order` nullable `customerUserId`, `paymentMethod`, `paymentStatus`, `note`, `paperType`, `acceptedAt`, `completedAt`, `isReviewed`; `OrderStatus` + `REJECTED`; index `(customerUserId, createdAt)` | `acceptedAt`/`completedAt` from `OrderStatusHistory`; old rows keep null customer | historical orders readable by existing queries |
| M6 payment/review | `OrderPayment`, unique `(shopId, upiTxnRef)` where not null; `Review` unique `orderId`, check 1..5; `UserNotification` | none | |
| M7 audit | none (action names only) | none | |

Risks: (a) nullable-email unique index semantics (Postgres allows multiple NULLs; confirm no code assumes non-null email: `grep` of `user.email` consumers required before M1). (b) `ALTER TYPE ADD VALUE` cannot run inside a transaction block on older PG; Prisma handles it, test on a disposable database. (c) Unique `(shopId, upiTxnRef)` must be partial. (d) Verified backfill must run in the same release as the discovery code.

Rollback: new tables and nullable columns can be dropped by a later approved migration; enum values stay. Application rollback is safe because old code ignores new columns. Before any production run: verified backup, restore trial to a disposable DB, `migrate deploy` there, `migrate diff` zero drift, explicit owner approval. Never run against production from this branch.

Existing data mappings: shop ownership (`User.shopId` and `Membership` already agree after the earlier backfill; re-verify), auth identities (untouched), devices/printers/jobs (untouched).
