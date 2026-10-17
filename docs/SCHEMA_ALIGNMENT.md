# Schema alignment with the approved architecture

Source: `PrintoutBuddy Architecture.pdf` (p1 Data model, p6 ER, p12-13 lifecycles). Stack unchanged: TypeScript, Fastify, Prisma, PostgreSQL. Migration: `apps/api/prisma/migrations/20261016120000_target_architecture_additive`.

## Rules followed

Forward-only and additive. No applied migration was edited. No table or column was dropped, renamed or retyped. `Order` stays authoritative. No status mapping was invented. Nothing in the application reads or writes the new tables yet, so behaviour is unchanged. Payments, OTP, staff authorization, automatic one-year deletion and the Windows agent are not enabled.

## What was added

| PDF entity | Change | Notes |
|---|---|---|
| Shop | `ShopStatus` gains `PILOT`, `PAST_DUE`, `CANCELLED`; `Shop.kmsKeyRef` (nullable) | Default stays `ACTIVE`. No code sets the new values. |
| Plan metadata | `Plan.key` (unique, nullable), `maxAgents`, `maxPrinters`, `staffEnabled` (all nullable) | Values not set: Basic/Pro limits are in the PDF but not approved as data. |
| Membership | new `Membership` (`shopId`, `userId`, `role OWNER/STAFF`, unique pair) | Backfilled once from existing `SHOP_OWNER` users. `User.shopId` remains the authoritative link. |
| PrintAgent / Printer | new `PrintAgent` (credential hash, version, last seen, revoked), new `Printer` (`colour`, `duplex`, `active`) | Separate from `ShopDevice` (Android). Plan limits (1 / 3) are application checks, not constraints. |
| PrintJob | new `PrintJob` (`code`, `serviceDay`, `status`, `attempt`, lease fields, `expiresAt`, optional unique `orderId`) with unique (`shopId`, `serviceDay`, `code`) | No rows are created from Orders. |
| Multi-document jobs | `Document.printJobId` (nullable FK) | Existing one-document-per-Order rows are untouched. |
| DeletionReceipt | new `DeletionReceipt` (unique `receiptId`, unique `documentId`, `sha256`, `wipeFlags` JSON, `verifiedAt`) | |
| CustomerSession | new `CustomerSession` (`tokenHash` unique, `ipPrefix`, `expiresAt`) | Anonymous; 2-hour expiry is application logic. |
| Subscription / Invoice / Payment | `Subscription.gatewaySubscriptionId` (unique, nullable); new `Invoice`, `Payment` with unique gateway ids | Statuses are free text until a provider is chosen. |
| AuditLog | unchanged (already has `actorType`, `metadata`) | Append-only is not enforced, see below. |

## Verification (disposable databases only)

On a copy holding seeded data (2 shops, 3 users, 60 orders, 60 documents, 3 audit rows) the migration left every row count unchanged and created 2 memberships (one per owner). `prisma migrate diff` between the migrated database and `schema.prisma` reports no difference. The full chain also applies to an empty database. The generated SQL contains no `DROP`, `ALTER COLUMN`, `DELETE` or `TRUNCATE`.

## Unresolved decisions (not guessed)

1. **Order to PrintJob mapping** and when `PrintJob` becomes authoritative (status mapping, historical reads, tracking tokens, idempotency keys).
2. **Wipe flag names.** The PDF says "three wipe flags" for the receipt without naming them; stored as JSON.
3. **Document lifecycle states** (uploaded, scanned, ready, claimed, spooled, deleted, rejected, expired) versus today's `UPLOADING/AVAILABLE/PRINTED_RETENTION/DELETED/FAILED`. No enum change.
4. **Append-only AuditLog.** A trigger or restricted grant would conflict with `Shop` deletion (`ON DELETE SET NULL` updates audit rows); needs a decision on how shops are retired.
5. **Plan limits as data** (Basic: 1 agent, 1 printer; Pro: 3 printers, staff) and who may change them.
6. **Invoice/Payment status vocabulary** and webhook event schemas; payment provider.
7. **Owner OTP identity** and admin 2FA: `User` is password-based today.
8. **Upload limit.** The PDF targets 25 MB per document; the API default stays 50 MB (`UPLOAD_MAX_BYTES=52428800`) so current clients keep working. Changing it is a configuration decision.
9. **One-year metadata retention** (PDF flags legal review): not activated.
10. **KMS operator and per-shop key scheme** behind `kmsKeyRef`.

## Rollback

The migration is purely additive. To undo on a database that has not started using the new tables, drop the new tables and added columns. The three new enum values stay (Postgres cannot remove enum values); no application code depends on them.

## Shop operating hours (migration `20261017100000_shop_operating_hours`)

Additive only: enum `AfterHoursPolicy`; `ShopSettings.timezone` (default `Asia/Kolkata`), `operatingHours` JSONB (null = none), `specialClosures` JSONB (default `[]`), `temporaryClosure` JSONB, `reopenUntil` timestamp, `afterHoursPolicy` (default `ACCEPT`). No backfill, no drops, no renames; existing rows keep today's behaviour. JSON shapes and interval, overnight, closure and policy semantics are specified in `docs/SHOP_HOURS.md`. Rollback: older code ignores the columns; removal would be a separate, approved migration. Validated on a disposable database (`migrate deploy`, `migrate diff` shows no drift).
