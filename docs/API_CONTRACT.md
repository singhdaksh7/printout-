# API contract

**Status:** implemented unless marked *(planned)*. Base path: `/api/v1` (plus `/health`, `/ready` at the root). JSON uses camelCase. Successful responses return `{ "data": ... }`; errors return `{ "error": { "code", "message", "requestId", "details?" } }` (no stack traces; 5xx always `INTERNAL_ERROR`). Request bodies are Zod-validated and **strict** (unknown keys => `400 VALIDATION_ERROR`, `details` = flattened Zod issues). IDs and tracking tokens are opaque strings. Authenticated shop responses are scoped to the session's shop; callers never select a tenant.

## Shared concepts

`OrderStatus = NEW | ACCEPTED | PRINTING | PRINTED | READY | COLLECTED | CANCELLED | EXPIRED`.
`DocumentStatus = UPLOADING | AVAILABLE | PRINTED_RETENTION | DELETED | FAILED`. Document status is independent of order status.
`Role = SHOP_OWNER | PLATFORM_ADMIN`.
`PrintOptions = { paperSize: "A4", colourMode: "bw"|"colour", sides: "single"|"duplex", copies: 1..1000, pageSelection: { mode: "all" } | { mode: "ranges", ranges: [{ from, to }] (1..50) } }`.
`UploadLimits = { acceptedMimeTypes, maxBytes: 52428800, maxPdfPages: 200, imagePageCount: 1 }` (configurable).

Pricing (frozen): `sheetsPerCopy = selectedPages` (single) or `ceil(selectedPages/2)` (duplex); `totalSheets = sheetsPerCopy x copies`; `totalPaise = totalSheets x pricePerSheetPaise`. The server alone computes price.

### Error codes
Existing: `INVALID_FILE_TYPE FILE_TOO_LARGE EMPTY_FILE PDF_TOO_MANY_PAGES INVALID_PDF PASSWORD_PROTECTED_PDF INVALID_PAGE_RANGE ORDER_NOT_FOUND DOCUMENT_UNAVAILABLE INVALID_STATUS_TRANSITION UNAUTHORIZED FORBIDDEN CSRF_INVALID RATE_LIMITED VALIDATION_ERROR NOT_FOUND INVALID_QUOTE QUOTE_EXPIRED NO_PRICING_RULE SHOP_UNAVAILABLE`.
**Added (additive):** `INVALID_CREDENTIALS` (401 login), `SHOP_SUSPENDED` (403 login/session of a suspended shop), `DOCUMENT_ALREADY_USED` (409, document already has an order), `IDEMPOTENCY_CONFLICT` (409, `clientRequestId` reused for a different document), `DUPLICATE_PRICING_RULE` (409), `CONFLICT` (409, e.g. admin slug/email taken; `details.field`), `PAYLOAD_TOO_LARGE` (413), `INTERNAL_ERROR` (500/503).
**Change:** unauthenticated responses now use `UNAUTHORIZED` (previously `UNAUTHENTICATED`); validation failures use `VALIDATION_ERROR` (previously some `REQUEST_ERROR`). Typical statuses: 400 validation, 401 unauthenticated, 403 forbidden/CSRF/suspended, 404 unknown or cross-tenant, 409 state conflict, 410 document no longer available, 422 business rule, 429 rate limited.

### Auth model
Cookie `printout_session` (HttpOnly, SameSite=Lax, Secure in production, `Path=/api/v1` so it also reaches `/api/v1/shop/events`). Every cookie-authenticated **POST/PUT/DELETE** requires header `x-csrf-token` (value from login/session response); GET never mutates. Login rotates sessions; logout invalidates server-side; suspending a shop invalidates its sessions.

## Public customer endpoints (no auth, rate-limited)

| Endpoint | Result |
| --- | --- |
| `GET /public/shops/{slug}` | `{ status:"ACTIVE", slug, displayName, address?, publicContact?, acceptsOrders, branding?:{brandColor}, printCapabilities:{paperSizes,colourModes,sides} }`. **Suspended shops return 200** `{ slug, displayName, status:"SUSPENDED", acceptsOrders:false }` (no private data). Unknown slug: 404. |
| `POST /public/shops/{slug}/uploads/initiate` | `{ uploadId, uploadUrl, requiredHeaders, expiresAt, limits }` (FILES pipeline). Suspended/unknown shop: 404. |
| `POST /public/shops/{slug}/uploads/{uploadId}/complete` | `{ documentId, detectedMimeType, byteSize, pageCount, documentStatus:"AVAILABLE", uploadedAt, expiresAt }` |
| `POST /public/shops/{slug}/quotes` | body `{ documentId, printOptions }` -> `{ quoteId, printOptions (normalised), selectedPageCount, sheetsPerCopy, totalSheets, unitPricePaise, totalPaise, currency:"INR", expiresAt }`. `quoteId` is an opaque **HMAC-signed** token (document, shop, normalised options, expiry; no price). TTL `QUOTE_TTL_SECONDS` (600). Errors: `INVALID_PAGE_RANGE` 422 (out of range / from>to / >50 ranges), `NO_PRICING_RULE` 422, `DOCUMENT_UNAVAILABLE` 422, `SHOP_UNAVAILABLE` 409 (not accepting orders), 404 (suspended). |
| `POST /public/shops/{slug}/orders` | body `{ quoteId, customerDisplayNameOrReference?, clientRequestId (uuid) }` -> `{ orderNumber, trackingToken, status:"NEW", totalPaise, currency }`. The server re-loads the document and **current** pricing and recalculates; a stale quote yields the new total. Errors: `INVALID_QUOTE`, `QUOTE_EXPIRED`, `DOCUMENT_UNAVAILABLE`, `DOCUMENT_ALREADY_USED`, `IDEMPOTENCY_CONFLICT`. **Idempotent** on `(shop, clientRequestId)`: retries return the original order. `orderNumber` is `PREFIX-0001` (per-shop sequence). |
| `GET /public/orders/{trackingToken}` | `{ serverTime, shopSlug, orderNumber, shopName, status, totalPaise, currency, createdAt, updatedAt, printOptions, selectedPageCount, document:{ fileName, pageCount, status, deleteAfter?, deletedAt? }, documentDeleteAfter?, timeline:[{ status, at }] }`. Unknown or malformed tokens: constant 404 `NOT_FOUND`. Never exposes ids, storage keys or URLs. |

## Auth

| Endpoint | Result |
| --- | --- |
| `POST /auth/login` | body `{ email, password }` -> `{ user:{id,displayName,role}, shop:{id,slug,displayName}\|null, csrfToken }` + cookie. `401 INVALID_CREDENTIALS` (identical for unknown email), `403 SHOP_SUSPENDED`, `429 RATE_LIMITED` (route limit and IP+email failure lockout). |
| `POST /auth/logout` | CSRF; `204` |
| `GET /auth/session` | same shape as login |

## Shop (role SHOP_OWNER; all queries scoped by session shop)

| Endpoint | Result |
| --- | --- |
| `GET /shop/orders?status=&active=&cursor=&limit=` | `{ items:[{ id, orderNumber, status, totalPaise, currency, createdAt, updatedAt, customerDisplayNameOrReference, originalFilename, pageCount, selectedPageCount, colourMode, sides, copies, documentStatus, deleteAfter }], nextCursor? }`. Newest first; `status` accepts one value or comma list; `active=1` hides COLLECTED/CANCELLED/EXPIRED; `limit` 1-100 (50); `cursor` opaque. |
| `GET /shop/orders/{id}` | `{ order:{ id, orderNumber, status, totalPaise, currency, createdAt, updatedAt, customerDisplayNameOrReference, originalFilename, selectedPageCount }, document:{ id, status, fileName, mimeType, pageCount, uploadedAt, expiresAt, printedAt, deleteAfter, deletedAt, deletionState:"OK"\|"FAILED"\|"DELETED" }, priceSnapshot, printOptionsSnapshot, statusHistory:[{ id, fromStatus, toStatus, reason, createdAt }] }` |
| `POST /shop/orders/{id}/transitions` | body `{ toStatus, reason?, clientRequestId }` -> `{ order }`. Allowed: NEW->ACCEPTED/CANCELLED, ACCEPTED->PRINTING/CANCELLED, PRINTED->READY, READY->COLLECTED, and NEW/ACCEPTED->EXPIRED only when the unprinted document has expired. `PRINTED` is **never** accepted here. ACCEPTED/PRINTING require a still-available document (`DOCUMENT_UNAVAILABLE` 409). Illegal: `409 INVALID_STATUS_TRANSITION`. Repeating the current status is a no-op 200. Emits `order.statusChanged` + `order.updated`. |
| `POST /shop/orders/{id}/print-confirmation` | body `{ clientRequestId }` -> `{ order:{id,orderNumber,status}, document:{ status:"PRINTED_RETENTION", printedAt, deleteAfter } }`. Requires order PRINTING and document AVAILABLE and unexpired (else 409). Atomically sets order PRINTED + document `printedAt`=server time, `deleteAfter = printedAt + PRINT_RETENTION_MINUTES`. **Idempotent**: repeats return the original timestamps and never change them. |
| `POST /shop/orders/{id}/document-access` | `{ url, expiresAt, contentDisposition:"inline", mimeType }`. TTL = min(300s, time to deadline). Denied with `410 DOCUMENT_UNAVAILABLE` at/after `deleteAfter` (even if the worker has not run), after `expiresAt` for unprinted docs, when DELETED, or for CANCELLED/EXPIRED orders. Never changes timestamps. |
| `GET\|PUT /shop/settings` | `{ slug, displayName, address, publicContact, brandColor, acceptsOrders }`; PUT accepts any non-empty subset of `displayName, address, publicContact, brandColor(#rrggbb), acceptsOrders` (strict). |
| `GET /shop/pricing-rules` | array of `{ id, paperSize, colourMode, sides, pricePerSheetPaise, active, createdAt, updatedAt }` |
| `POST /shop/pricing-rules` | `{ colourMode, sides, pricePerSheetPaise, paperSize?:"A4", active?:true }` -> 201 rule; duplicate `colourMode x sides` -> `409 DUPLICATE_PRICING_RULE` |
| `PUT /shop/pricing-rules/{id}` | partial of the same fields; `DELETE` -> 204. Other shop's id -> 404. |
| `GET /shop/qr` | `{ publicUrl, slug, shopName }` (frontend renders the QR) |
| `GET /shop/analytics?from=&to=` | default range = today in Asia/Kolkata. `{ timezone, range:{from,to}, ordersToday, orderCount, pagesToday, estimatedOrderValuePaise, bwCount, colourCount, ordersByStatus, recentActivity:[{ orderId, orderNumber, fromStatus, toStatus, at }] }`. `pagesToday = sum(selectedPageCount x copies)` over non-cancelled/expired orders; value/bw/colour exclude CANCELLED/EXPIRED. Value is an estimate, never "revenue". Range max 93 days. |
| `GET /shop/events` | SSE, see below |

## Realtime (SSE) `GET /shop/events`
Cookie-authenticated (session re-validated on connect and every heartbeat; closes on logout/suspension). Headers: `text/event-stream`, `no-cache`, CORS. `: ping` comment every 25s. Each event has a numeric monotonic `id`; send `Last-Event-ID` to replay from a per-shop in-memory ring buffer (200 events). Events (payloads minimal, no URLs/content): `order.created {id,orderNumber,status,updatedAt}`, `order.updated`, `order.statusChanged` (same shape), `document.deletionScheduled {orderId,documentId,deleteAfter}`, `document.deleted` (reserved: emitted only by an in-process caller of `events.emit(shopId, 'document.deleted', {...})`; the separate worker process cannot reach the bus, so clients must also poll/refetch near `deleteAfter`). Clients reconcile by refetching.

## Platform admin `/admin/*` (role PLATFORM_ADMIN; CSRF on mutations; all mutations audit-logged; never exposes documents/URLs)
- `GET /admin/dashboard` -> `{ timezone, totalShops, shopsByStatus, activeSubscriptions, subscriptionsByStatus, ordersToday }`
- `GET /admin/shops?status=&q=&cursor=&limit=` -> `{ items:[shop + subscription], nextCursor? }`; `POST /admin/shops` body `{ slug, displayName, address?, planId?, owner:{ email, displayName, password(>=12) } }` -> 201 `{ shop, owner }` (password never echoed); `409 CONFLICT` for taken slug/email.
- `GET /admin/shops/{id}` -> `{ shop, owners, subscription, usage:{ orderCount, ordersLast30Days, pricingRuleCount, lastOrderAt } }`; `PUT /admin/shops/{id}` `{ displayName?, address?, acceptsOrders?, status?: ACTIVE|SUSPENDED }` (suspend invalidates the shop's sessions; slug immutable).
- `GET|POST /admin/plans`, `PUT /admin/plans/{id}` `{ name?, pricePaise?, active? }`.
- `GET /admin/subscriptions?status=&cursor=` ; `PUT /admin/subscriptions/{shopId}` `{ status?: ACTIVE|SUSPENDED|CANCELLED, planId?, renewsAt?: ISO|null }` (creates if absent, `planId` then required). Subscription status is informational: it does **not** auto-suspend the shop.
- `GET /admin/audit-logs?shopId=&action=&cursor=&limit=` -> `{ items:[{ id, shopId, actorUserId, action, targetType, targetId, metadata, createdAt }], nextCursor? }` newest first.

## Configuration notes
New env: `QUOTE_SECRET`, `QUOTE_TTL_SECONDS`, `STORAGE_URL_SECRET`, `PUBLIC_API_BASE`, `TRUST_PROXY`, `JSON_BODY_LIMIT_BYTES`, `COOKIE_SAMESITE`, `LOGIN_RATE_LIMIT_MAX`, `LOGIN_FAIL_MAX`, `LOGIN_FAIL_WINDOW_MINUTES`, `PUBLIC_RATE_LIMIT_MAX`, `SSE_HEARTBEAT_MS`, `DOCUMENT_CLEANUP_*`, `S3_*` (required only when `STORAGE_DRIVER=s3`). `NODE_ENV=production` refuses placeholder/short/identical secrets and non-https `WEB_ORIGIN`. See `.env.example`.

## Contract evolution
Additive optional fields are preferred; breaking changes require an explicit versioning decision. Not yet implemented: automated subscription/payment integration, QR image generation (client-side), cross-process SSE fan-out.
