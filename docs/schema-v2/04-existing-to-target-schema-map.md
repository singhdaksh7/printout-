# 04 – PDF entity → existing entity → change → migration strategy

All migrations are expand-only: nullable columns, new tables, additive enum values. No drops in the first release.

| PDF entity | Existing | Change needed | Migration strategy |
|---|---|---|---|
| users | `User` + identity tables | Add `CUSTOMER` to `Role`; allow nullable `email`; add address, latitude, longitude, `isActive`; new `UserRoleGrant(userId, role)`; referral deferred | Nullable columns. Backfill `UserRoleGrant` from `User.role`. `User.role` is not rewritten. |
| userRole | `Role` | Add `CUSTOMER`. PDF `shopOwner`/`admin` = `SHOP_OWNER`/`PLATFORM_ADMIN` (API alias only) | `ALTER TYPE ... ADD VALUE` (cannot be removed later, harmless) |
| userFcmTokens | `FcmRegistration` | Customers register with `shopId` null (already nullable). Keep encryption. | none |
| shops | `Shop` + `ShopSettings` | Add phone, email, address parts, latitude, longitude, `isVerified`/`verifiedAt`/`verifiedBy`, `upiId`, `acceptedPaymentMethods`, rating aggregate. `isActive` = `status == ACTIVE`; `isOpen` = server `evaluateAvailability` and `acceptsOrders` | Backfill `isVerified = true` for existing ACTIVE shops. Shops with null coordinates are excluded from nearby search only. |
| shopRates | `PricingRule` | Keep. API view maps `(paperSize, colour, sides)`; a per-page figure is projected only for single-sided rules | none |
| shopPaperOptions | none | New `(shopId, kind, value)` unique table. Seed paperSize from distinct existing `PricingRule.paperSize`. paperType starts empty | Backfill from existing rules. No A3/glossy claim without owner input or printer capability data |
| shopImages | none | New `(shopId, imageKey, sortOrder)` table, private keys | new table |
| orders | `Order` + `Document` | Add `customerUserId`, `paymentMethod`, `paymentStatus`, `note`, `paperType`, `acceptedAt`, `completedAt`, `isReviewed`. `ownerId` is derived through shop membership instead of denormalised | Nullable columns; historical rows stay valid as guest orders. `acceptedAt`/`completedAt` backfilled from history |
| orderNumber | `Order.orderNumber` | Keep per-shop numbering | none |
| orderStatus | `OrderStatus` | Add `REJECTED`; PDF names map as in 08 | additive enum value |
| orderStatusHistory | same | none (`changedBy` = `actorUserId`) | none |
| paymentMethod / paymentStatus | none | New enums and `OrderPayment` table | new objects |
| reviews | none | New `Review`, unique `orderId`, check 1..5 | new table |
| notifications | `ShopNotification` | New `UserNotification` for customers, same outbox and post-commit rules | new table |
| auditLogs | `AuditLog` | Before/after go in `metadata`; add `shop.verify`, `shop.unverify`, `shop.block`, `shop.unblock` actions | none |

Extra existing infrastructure stays unmodified (see 01 section 8).
