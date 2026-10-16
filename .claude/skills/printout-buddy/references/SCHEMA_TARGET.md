# Target data model and migration design

**Sources:** approved PDF p1 Data model and p6 ER diagram, p12–13 lifecycles. **Not an executable/approved DDL:** conceptual entities and rules are specified; types/defaults/FKs not fully specified. Audit as-is: 13 Prisma models, 9 enums, 5 migrations (`apps/api/prisma/schema.prisma`).

## Target entities

| Entity | Explicit PDF fields/semantics | Constraints explicitly stated | Relation / migration mapping |
|---|---|---|---|
| Shop | slug, status, plan, kms_key_ref | slug unique; statuses pilot/active/past_due/suspended/cancelled | extend existing `Shop`; plan association TBD |
| User | authenticated owner/staff/admin identity | login via OTP in target | existing `User` requires auth transition design |
| Membership | shop_id, user_id, role | unique(shop_id,user_id); owner/staff; staff only Pro and no billing read | new join model; migrate existing `User.shopId` carefully |
| PrintAgent | credential_hash, last_seen_at | Basic max 1 active agent/shop; rotate credential on re-pair | new target entity, existing `ShopDevice` isn't equivalent |
| Printer | agent_id, colour, duplex | Basic 1 printer; Pro up to 3, checked on insert | new model; enforce shop/agent consistency |
| PrintJob | code, service_day, status, lease fields | unique(shop_id,service_day,code); 4-digit daily code; expiry = first upload+60 min | from existing `Order` only via mapping/backfill |
| Document | object_key, sha256, expires_at | max 10/job; 25 MB/document; 200 pages/job in aggregate; no file content/text DB column | existing one-document-per-order needs 1:N redesign |
| DeletionReceipt | document_id, sha256, 3 wipe flags | unique/document; receipt id accepted once | new append/verification model |
| Subscription | gateway references, state | gateway ids unique when applicable | extend existing model |
| Invoice | billing/invoice IDs | gateway ids unique | new model |
| Payment | gateway payment/event IDs | replay-safe uniqueness | new model |
| AuditLog | actor_id, action, target_ref | append-only; content-free | extend existing audit with restricted permissions |
| CustomerSession | token_hash, ip_prefix | anonymous, expires in 2 hours | distinct from owner/admin `Session` |

## Enumerated lifecycles

**PrintJob** (PDF p12): uploading → queued → printing → printed; failed (can retry to queued); cancelled; expired. Guards: upload completion, atomic lease, cancellation rules, expiry. Transitional status mapping to existing `NEW/ACCEPTED/PRINTING/PRINTED/READY/COLLECTED/CANCELLED/EXPIRED` requires an explicit historical-read policy.

**Document** (PDF p13): uploaded → scanned → ready → claimed → spooled → deleted; rejected or expired exits. Treat `FAILED`/`PRINTED_RETENTION` from existing Prisma separately; do not erase prior states without migration strategy.

## Proposed implementation phases (not PDF mandates)

1. Freeze as-is schema snapshot and collect real deployed migration state, backup/restore verification and client compatibility matrix.
2. Add new target entities alongside old (`Membership`, `Printer`, `DeletionReceipt`, `CustomerSession`, `Invoice`, `Payment`) with nullable transitional columns where needed.
3. Backfill membership from existing users, map devices/agents only with identity/capability reconciliation; preserve old credential hashes and revoked states.
4. Introduce `PrintJob` and document join/ownership in dual-read/compatibility period; preserve old Order IDs, tokens, timestamps, prices and idempotency.
5. Implement lease ownership/renewal/receipt idempotency and retention semantics with transaction tests; reconcile clock and invoice policies.
6. Migrate contracts and client compatibility; switch traffic in staging, then production through explicit release approval. Only later remove old columns/tables.

## Required decisions before writing DDL

- Exact table/column names, DB types, IDs, delete rules, timestamps, nullability, indexes, access control, encryption references.
- Receipt `wipe flags` names and authenticity proof; billing/webhook exact event schemas.
- Owner OTP identity/membership migration and admin auth migration.
- Historical Order→PrintJob mapping, multiple file attachment transition, old lifecycle retention.
- Whether PDF's proposed timings and one-year metadata retention are approved legal/operational requirements.

## Acceptance criteria

- Migration from representative historical fixture and clean DB both succeed; no data loss.
- Tenant boundaries, job-code uniqueness, claims, printer limits, expiry and receipt idempotency are covered in tests.
- Existing supported clients keep working until controlled cutover.
