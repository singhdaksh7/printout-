# Phase 3 contract: customer orders

Status: **IMPLEMENTED on branch `feature/daksh-schema-v2-phase3-orders`; becomes CURRENT_PRODUCTION only when `IMPLEMENTATION_PROGRESS.md` says DEPLOYED with evidence.** Additive. The guest QR flow (`/public/...`) is unchanged in behaviour; its order-creation code now lives in `domain/order-create.ts` and is shared (119 existing order/upload/lifecycle/hours/tenant tests pass unchanged). One tightening: the guest quote now refuses documents uploaded by an authenticated customer.

All routes below require a **customer session** (owners, admins: 403; anonymous: 401). Envelope `{ data }` / `{ error }` as everywhere else.

## Flow

1. `POST /customer/uploads` `{ shopId, fileName, byteSize, declaredMimeType }` (pdf, jpeg, png; `byteSize` 1..50 MiB). Shop must be verified, ACTIVE, accepting orders and open by hours (`404 SHOP_NOT_FOUND`, `409 SHOP_UNAVAILABLE`, `409 SHOP_CLOSED`). Limit: 50 uploads per customer per hour (`429`, counted in the database). Returns `{ uploadId, uploadUrl, requiredHeaders, completePath, expiresAt, limits }`.
2. `PUT uploadUrl` with the raw file and the required `content-type` (token-protected, single-use, 15 min, streamed to private storage; this is the existing pipeline).
3. `POST {completePath}` (no body): the server checks the real file type by magic bytes, counts pages and returns `{ documentId, pageCount, documentStatus: "AVAILABLE", ... }`.
4. `POST /customer/quotes` `{ shopId, documentId, printOptions }` -> `{ quoteId, shopId, totalPaise, ..., expiresAt }`. `printOptions`: `paperSize "A4"`, `paperType "normal"` (optional), `colourMode bw|colour`, `sides single|duplex`, `copies 1..50`, `pageSelection`. Any other paper size or type is `400`: only A4 plain paper is priced today. Unknown keys (including any client price) are `400`.
5. `POST /customer/orders` `{ quoteId, clientRequestId? , note? }` plus optional `Idempotency-Key` header (UUID; header and body must agree; one of them is required). `note` max 500. Returns `201` with the order view. The price is **recalculated by the server from the shop's current per-sheet rules** (integer paise, duplex handled by the same engine as the guest flow); the quote token carries no price.
6. `GET /customer/orders?status&page&limit` (limit max 50), `GET /customer/orders/{id}` (adds `statusHistory[{ status, by: customer|shop|system, reason, createdAt }]`), `POST /customer/orders/{id}/cancel` `{ cancelReason? }`.

Order view: `id, orderNumber, shopId, shopName, status, totalPaise, currency, printOptions, priceSnapshot, fileName, pages, fileDeletedAt, note, createdAt, updatedAt`. Never returned: tracking token, storage key, actor ids, other customers' data.

## Rules

- **Ownership**: a document is bound to its uploader; another customer, a guest, or a stolen quote token cannot quote or order it (`422 DOCUMENT_UNAVAILABLE`). A guest cannot consume a customer's document. An order or `clientRequestId` of another customer is a `404` / `409 IDEMPOTENCY_CONFLICT` with no data in the error (PDF's `403 NOT_ORDER_OWNER` is deliberately `404` so ids cannot be probed).
- **Idempotency** per (shop, clientRequestId): a replay by the same customer returns the same order; any other principal gets `409`.
- **Cancel**: only `NEW` or `ACCEPTED` and only before a print was initiated; compare-and-set so a concurrent shop action wins; idempotent for an already cancelled order; otherwise `409 INVALID_STATUS_TRANSITION`. Writes history (actor = customer), audit `order.cancelled_by_customer`, and emits the shop's SSE events after commit. (`REJECTED` and payments arrive in phase 4.)
- **Retention and files**: unchanged (decision D3): 24 h for unprinted documents, 30 minutes after print; the 50 MiB limit is kept. There is **no customer file re-download endpoint** (BLOCKED while retention is 30 minutes).
- **Windows Agent / devices**: untouched. Customer orders enter the same `NEW` queue and use the same print-now / device flow; nothing here can replay a physical print.

## Database (migration `20261028120000_customer_orders`)

`Document.uploaderUserId` and `Order.customerUserId` (nullable, FK `SET NULL`, indexed), `Order.note` (CHECK <= 500). Guest rows keep NULL and are unaffected. Verified on a disposable PG16 with `prisma migrate diff` clean.

## Android notes

Customer app: follow steps 1-6; show prices from `quote`/order responses only. Existing owner app: no change.
