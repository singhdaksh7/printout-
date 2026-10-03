# API contract (planned)

**Status:** planned, not implemented. Base path: `/api/v1`. JSON uses camelCase. Successful responses return `{ "data": ... }`; errors return `{ "error": { "code", "message", "requestId", "details?" } }`. All bodies are Zod-validated. IDs and public tracking tokens are opaque strings. Authenticated shop responses are scoped to the session's shop; callers never select a tenant.

## Shared concepts

`OrderStatus = NEW | ACCEPTED | PRINTING | PRINTED | READY | COLLECTED | CANCELLED | EXPIRED`.

`DocumentStatus = UPLOADING | AVAILABLE | PRINTED_RETENTION | DELETED | <technical failure states>`. Document status is independent of order status.

`Role = SHOP_OWNER | PLATFORM_ADMIN`.

`PrintOptions = { paperSize: "A4", colourMode: "bw" | "colour", sides: "single" | "duplex", copies: number, pageSelection: { mode: "all" } | { mode: "ranges", ranges: [{ from: number, to: number }] } }`.

`UploadLimits = { acceptedMimeTypes: ["application/pdf", "image/jpeg", "image/png"], maxBytes: 52428800, maxPdfPages: 200, imagePageCount: 1 }`. These are V1 defaults and must be environment/configurable when implemented.

V1 pricing rules are `{ paperSize: "A4", colourMode, sides, pricePerSheetPaise }`. The backend computes `sheetsPerCopy` as selected pages for `single`, or `ceil(selected pages / 2)` for `duplex`; then computes `totalSheets = sheetsPerCopy × copies` and `totalPaise = totalSheets × pricePerSheetPaise`. This resolves V1 deterministically; the pilot may later decide whether a distinct per-page duplex commercial model is needed.

Public data deliberately omits storage keys, shop-user identities, internal notes, and document URLs. A tracking token is non-guessable and is the only public order authorization credential; `orderNumber` is display-only.

## Public customer endpoints

| Endpoint | Intent | Representative payload/result |
| --- | --- | --- |
| `GET /public/shops/{slug}` | Shop lookup | `data: { slug, displayName, address?, acceptsOrders, printCapabilities: { paperSizes:["A4"] } }` |
| `POST /public/shops/{slug}/uploads/initiate` | Validate one permitted file and issue one-time private upload instruction | body `{ fileName, byteSize, declaredMimeType }`; result `{ uploadId, uploadUrl, requiredHeaders, expiresAt, limits: UploadLimits }` |
| `POST /public/shops/{slug}/uploads/{uploadId}/complete` | Verify object and create an `AVAILABLE` temporary document | result `{ documentId, detectedMimeType, byteSize, pageCount, documentStatus:"AVAILABLE", uploadedAt, expiresAt }` |
| `POST /public/shops/{slug}/quotes` | Authoritative quote | body `{ documentId, printOptions }`; result `{ quoteId, printOptions, selectedPageCount, sheetsPerCopy, totalSheets, unitPricePaise, totalPaise, currency:"INR", expiresAt }` |
| `POST /public/shops/{slug}/orders` | Submit a quoted order using its one uploaded document | body `{ quoteId, customerDisplayNameOrReference?, clientRequestId }`; result `{ orderNumber, trackingToken, status:"NEW", totalPaise, currency:"INR" }` |
| `GET /public/orders/{trackingToken}` | Minimal public status | result `{ orderNumber, shopName, status, totalPaise, currency, updatedAt, documentDeleteAfter? }` |

Upload completion must verify type/size/signature server-side, enforce 50 MB and 200-PDF-page V1 defaults, and set the 24-hour expiry from successful completion even when no order is submitted. Direct-to-object-storage is preferred; a same-origin streamed fallback may be used without changing privacy semantics.

## Shop authentication

| Endpoint | Intent | Representative payload/result |
| --- | --- | --- |
| `POST /auth/login` | Cookie session login | body `{ email, password }`; result `{ user: { id, displayName, role:"SHOP_OWNER" | "PLATFORM_ADMIN" }, shop?: { id, slug, displayName } }` |
| `POST /auth/logout` | End session | CSRF-protected; result `204` |
| `GET /auth/session` | Restore current session | result `{ user, shop, csrfToken }` |

Login is rate-limited. Passwords use Argon2id. Cookie mutations require CSRF protection.

## Shop orders and printing

| Endpoint | Intent | Representative payload/result |
| --- | --- | --- |
| `GET /shop/orders?status=NEW&cursor=` | Paginated live-queue snapshot | result `{ items: [OrderSummary], nextCursor? }` |
| `GET /shop/orders/{orderId}` | Full authorized detail | result `{ order, document: { id, status:DocumentStatus, pageCount, uploadedAt, expiresAt, printedAt?, deleteAfter?, deletedAt?, deletionState }, priceSnapshot, printOptionsSnapshot, statusHistory }` |
| `POST /shop/orders/{orderId}/transitions` | Request a server-validated state transition | body `{ toStatus, reason?, clientRequestId }`; result `{ order }` |
| `POST /shop/orders/{orderId}/print-confirmation` | Explicitly confirm printing succeeded | body `{ clientRequestId }`; result `{ order: { status:"PRINTED" }, document: { status:"PRINTED_RETENTION", printedAt, deleteAfter } }` |
| `POST /shop/orders/{orderId}/document-access` | Issue short-lived access for preview/print | result `{ url, expiresAt, contentDisposition:"inline" }` |

Only the backend can apply transitions: `NEW → ACCEPTED → PRINTING → PRINTED → READY → COLLECTED`, `NEW → CANCELLED`, and `ACCEPTED → CANCELLED`; `CANCELLED` and `EXPIRED` are terminal. Expiry applies where appropriate before successful printing. `print-confirmation` writes server-time `printedAt`, changes the document to `PRINTED_RETENTION`, and sets `deleteAfter = printedAt + exactly 30 minutes`; accessing/opening/printing a document never does. Reprinting does not reset or extend `deleteAfter`. At/after that time the object is permanently deleted and the document becomes `DELETED`, while safe order metadata remains.

## Shop configuration, QR, and analytics

| Endpoint | Intent | Representative payload/result |
| --- | --- | --- |
| `GET|PUT /shop/settings` | Read/update display, contact, operational settings | `PUT` body has explicit allowed settings only |
| `GET|POST|PUT|DELETE /shop/pricing-rules[/{ruleId}]` | Manage explicit deterministic A4 per-sheet rules | rule `{ colourMode, sides, paperSize:"A4", pricePerSheetPaise, active }` |
| `GET /shop/qr` | QR payload/information | `{ publicUrl, slug, svgOrPngDownloadUrl? }` |
| `GET /shop/analytics?from=&to=` | Tenant-scoped aggregates | `{ ordersByStatus, orderCount, quotedTotalPaise, collectedTotalPaise }` |

## Realtime (SSE)

`GET /shop/events` establishes an authenticated SSE stream. Events use `id`, `event`, and JSON `data`; reconnect supports `Last-Event-ID`.

Initial events: `order.created`, `order.updated`, `order.statusChanged`, `document.deletionScheduled`, `document.deleted`. Payloads contain the minimal shop-authorized order summary and version/update timestamp. The client reconciles by refetching order details when needed. No document URLs or content pass through SSE.

## Admin (planned)

Platform-admin endpoints are separately authorized and audited: `GET|POST|PUT /admin/shops`, `GET|PUT /admin/plans`, `GET|PUT /admin/subscriptions`, `GET /admin/audit-logs`. Subscription state is manually represented/activated/suspended in V1; automated subscription/payment integration is not part of MVP.

## Contract evolution

All endpoints above are **planned**. An endpoint becomes implemented only when its handler, validation, authorization, tests, and an API-contract status update land together. Breaking changes require an explicit versioning/migration decision; additive optional fields are preferred.
