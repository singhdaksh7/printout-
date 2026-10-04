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
| `GET /public/shops/{slug}` | `{ status:"ACTIVE", slug, displayName, address?, publicContact?, acceptsOrders, retentionMinutes, branding?:{brandColor}, printCapabilities:{paperSizes,colourModes,sides} }`. **Suspended shops return 200** `{ slug, displayName, status:"SUSPENDED", acceptsOrders:false, retentionMinutes }` (no private data). `acceptsOrders` is also `false` when the shop's subscription is `SUSPENDED`/`CANCELLED` (see Eligibility below). `retentionMinutes` (number) is the server-authoritative post-print retention window (`PRINT_RETENTION_MINUTES`, default 30); UIs display it and never hard-code it. Unknown slug: 404. |
| `POST /public/shops/{slug}/uploads/initiate` | `{ uploadId, uploadUrl, requiredHeaders, expiresAt, limits }` (FILES pipeline). Suspended/unknown shop: 404. |
| `POST /public/shops/{slug}/uploads/{uploadId}/complete` | `{ documentId, detectedMimeType, byteSize, pageCount, documentStatus:"AVAILABLE", uploadedAt, expiresAt }` |
| `POST /public/shops/{slug}/quotes` | body `{ documentId, printOptions }` -> `{ quoteId, printOptions (normalised), selectedPageCount, sheetsPerCopy, totalSheets, unitPricePaise, totalPaise, currency:"INR", expiresAt }`. `quoteId` is an opaque **HMAC-signed** token (document, shop, normalised options, expiry; no price). TTL `QUOTE_TTL_SECONDS` (600). Errors: `INVALID_PAGE_RANGE` 422 (out of range / from>to / >50 ranges), `NO_PRICING_RULE` 422, `DOCUMENT_UNAVAILABLE` 422, `SHOP_UNAVAILABLE` 409 (not accepting orders), 404 (suspended). |
| `POST /public/shops/{slug}/orders` | body `{ quoteId, customerDisplayNameOrReference?, clientRequestId (uuid) }` -> `{ orderNumber, trackingToken, status:"NEW", totalPaise, currency }`. The server re-loads the document and **current** pricing and recalculates; a stale quote yields the new total. Errors: `INVALID_QUOTE`, `QUOTE_EXPIRED`, `DOCUMENT_UNAVAILABLE`, `DOCUMENT_ALREADY_USED`, `IDEMPOTENCY_CONFLICT`. **Idempotent** on `(shop, clientRequestId)`: retries return the original order. `orderNumber` is `PREFIX-0001` (per-shop sequence). |
| `GET /public/orders/{trackingToken}` | `{ serverTime, retentionMinutes, shopSlug, orderNumber, shopName, status, totalPaise, currency, createdAt, updatedAt, printOptions, selectedPageCount, document:{ fileName, pageCount, status, deleteAfter?, deletedAt? }, documentDeleteAfter?, timeline:[{ status, at }] }`. Unknown or malformed tokens: constant 404 `NOT_FOUND`. Never exposes ids, storage keys or URLs. |

## Auth

| Endpoint | Result |
| --- | --- |
| `POST /auth/login` | body `{ email, password }` -> `{ user:{id,displayName,role}, shop:{id,slug,displayName}\|null, csrfToken, retentionMinutes }` + cookie. `401 INVALID_CREDENTIALS` (identical for unknown email), `403 SHOP_SUSPENDED`, `429 RATE_LIMITED` (route limit and IP+email failure lockout). |
| `POST /auth/logout` | CSRF; `204` |
| `GET /auth/session` | same shape as login |

## Shop (role SHOP_OWNER; all queries scoped by session shop)

| Endpoint | Result |
| --- | --- |
| `GET /shop/orders?status=&active=&cursor=&limit=` | `{ items:[{ id, orderNumber, status, totalPaise, currency, createdAt, updatedAt, customerDisplayNameOrReference, originalFilename, pageCount, selectedPageCount, colourMode, sides, copies, documentStatus, deleteAfter }], nextCursor? }`. Newest first; `status` accepts one value or comma list; `active=1` hides COLLECTED/CANCELLED/EXPIRED; `limit` 1-100 (50); `cursor` opaque. |
| `GET /shop/orders/{id}` | `{ order:{ id, orderNumber, status, totalPaise, currency, createdAt, updatedAt, customerDisplayNameOrReference, originalFilename, selectedPageCount }, document:{ id, status, fileName, mimeType, pageCount, uploadedAt, expiresAt, printedAt, deleteAfter, deletedAt, deletionState:"OK"\|"FAILED"\|"DELETED" }, priceSnapshot, printOptionsSnapshot, statusHistory:[{ id, fromStatus, toStatus, reason, createdAt }] }` |
| `POST /shop/orders/{id}/transitions` | body `{ toStatus, reason?, clientRequestId }` -> `{ order }`. Allowed: NEW->ACCEPTED/CANCELLED, ACCEPTED->PRINTING/CANCELLED, PRINTED->READY, READY->COLLECTED, and NEW/ACCEPTED->EXPIRED only when the unprinted document has expired. `PRINTED` is **never** accepted here. ACCEPTED/PRINTING require a still-available document (`DOCUMENT_UNAVAILABLE` 409). Illegal: `409 INVALID_STATUS_TRANSITION`. Repeating the current status is a no-op 200. Emits `order.statusChanged` + `order.updated`. |
| `POST /shop/orders/{id}/print-confirmation` | body `{ clientRequestId }` -> `{ order:{id,orderNumber,status}, document:{ status:"PRINTED_RETENTION", printedAt, deleteAfter } }`. Requires order PRINTING and document AVAILABLE and unexpired (else 409). Atomically sets order PRINTED + document `printedAt`=server time, `deleteAfter = printedAt + PRINT_RETENTION_MINUTES`. **Idempotent**: repeats return the original timestamps and never change them. |
| `POST /shop/orders/{id}/document-access` | `{ url, expiresAt, contentDisposition:"inline", mimeType }`. TTL = min(300s, whole seconds until the earliest of `deleteAfter` / (`expiresAt` for unprinted docs)); the returned `expiresAt` never exceeds that deadline and the storage layer additionally hard-caps every temporary URL at 300s (local and S3). Denied with `410 DOCUMENT_UNAVAILABLE` when less than one whole second remains, and also at/after `deleteAfter` (even if the worker has not run), after `expiresAt` for unprinted docs, when DELETED, or for CANCELLED/EXPIRED orders. Never changes timestamps. |
| `GET\|PUT /shop/settings` | `{ slug, displayName, address, publicContact, brandColor, acceptsOrders }`; PUT accepts any non-empty subset of `displayName, address, publicContact, brandColor(#rrggbb), acceptsOrders` (strict). |
| `GET /shop/pricing-rules` | array of `{ id, paperSize, colourMode, sides, pricePerSheetPaise, active, createdAt, updatedAt }` |
| `POST /shop/pricing-rules` | `{ colourMode, sides, pricePerSheetPaise, paperSize?:"A4", active?:true }` -> 201 rule; duplicate `colourMode x sides` -> `409 DUPLICATE_PRICING_RULE` |
| `PUT /shop/pricing-rules/{id}` | partial of the same fields; `DELETE` -> 204. Other shop's id -> 404. |
| `GET /shop/qr` | `{ publicUrl, slug, shopName }` (frontend renders the QR) |
| `GET /shop/analytics?from=&to=` | default range = today in Asia/Kolkata. `{ timezone, range:{from,to}, ordersToday, orderCount, pagesToday, estimatedOrderValuePaise, bwCount, colourCount, ordersByStatus, recentActivity:[{ orderId, orderNumber, fromStatus, toStatus, at }] }`. `pagesToday = sum(selectedPageCount x copies)` over non-cancelled/expired orders; value/bw/colour exclude CANCELLED/EXPIRED. Value is an estimate, never "revenue". Range max 93 days. |
| `GET /shop/events` | SSE, see below |

## Realtime (SSE) `GET /shop/events`
Cookie-authenticated (session re-validated on connect and every heartbeat; closes on logout/suspension). Headers: `Content-Type: text/event-stream`, `Cache-Control: no-store, no-cache, no-transform`, `X-Accel-Buffering: no`, `Connection: keep-alive`, CORS. At most `SSE_MAX_CONNECTIONS_PER_SHOP` (10) concurrent streams per shop and `RATE_LIMIT_SSE_CONNECT_MAX` (30) connects/min/session, else `429 RATE_LIMITED` + `Retry-After` (slots are released on close/error/abort). **The bus is in memory: the API must run as exactly ONE realtime-producing instance** until it is replaced (e.g. Postgres LISTEN/NOTIFY); extra replicas would silently miss events. `: ping` comment every 25s. Each event has a numeric monotonic `id`; send `Last-Event-ID` to replay from a per-shop in-memory ring buffer (200 events). Events (payloads minimal, no URLs/content): `order.created {id,orderNumber,status,updatedAt}`, `order.updated`, `order.statusChanged` (same shape), `document.deletionScheduled {orderId,documentId,deleteAfter}`, `document.deleted` (reserved: emitted only by an in-process caller of `events.emit(shopId, 'document.deleted', {...})`; the separate worker process cannot reach the bus, so clients must also poll/refetch near `deleteAfter`). Clients reconcile by refetching.

## Platform admin `/admin/*` (role PLATFORM_ADMIN; CSRF on mutations; all mutations audit-logged; never exposes documents/URLs)
- `GET /admin/dashboard` -> `{ timezone, totalShops, shopsByStatus, activeSubscriptions, subscriptionsByStatus, ordersToday }`
- `GET /admin/shops?status=&q=&cursor=&limit=` -> `{ items:[shop + subscription], nextCursor? }`; `POST /admin/shops` body `{ slug, displayName, address?, planId?, owner:{ email, displayName, password(>=12) } }` -> 201 `{ shop, owner }` (password never echoed); `409 CONFLICT` for taken slug/email.
- `GET /admin/shops/{id}` -> `{ shop, owners, subscription, usage:{ orderCount, ordersLast30Days, pricingRuleCount, lastOrderAt } }`; `PUT /admin/shops/{id}` `{ displayName?, address?, acceptsOrders?, status?: ACTIVE|SUSPENDED }` (suspend invalidates the shop's sessions; slug immutable).
- `GET|POST /admin/plans`, `PUT /admin/plans/{id}` `{ name?, pricePaise?, active? }`.
- `GET /admin/subscriptions?status=&cursor=` ; `PUT /admin/subscriptions/{shopId}` `{ status?: ACTIVE|SUSPENDED|CANCELLED, planId?, renewsAt?: ISO|null }` (creates if absent, `planId` then required). Subscription status does **not** auto-suspend the shop, but it gates public intake (see Eligibility). Audit actions: `admin.shop.create`, `admin.shop.suspend`, `admin.shop.activate`, `admin.shop.update`, `admin.plan.create|update`, `admin.subscription.update`, plus `admin.bootstrap.create|reset` (bootstrap CLI).
- `GET /admin/audit-logs?shopId=&action=&cursor=&limit=` -> `{ items:[{ id, shopId, actorUserId, action, targetType, targetId, metadata, createdAt }], nextCursor? }` newest first.

## Eligibility (public intake)
A shop accepts **new** public uploads (`initiate`/`complete`), quotes and orders only when `shop.status = ACTIVE` **and** (it has no subscription row **or** `subscription.status = ACTIVE`). Suspended shop: upload/quote/order -> 404. Subscription `SUSPENDED`/`CANCELLED`: upload `initiate` -> 404 `SHOP_UNAVAILABLE`, quote/order -> 409 `SHOP_UNAVAILABLE`, public page `acceptsOrders:false`. Existing orders, tracking and documents are untouched and the retention worker still deletes on schedule. Shop `SUSPENDED` blocks owner login/sessions (`403 SHOP_SUSPENDED`); a suspended *subscription* keeps login, reads and handling of existing orders working.

## Rate limiting (all `429 RATE_LIMITED` with the standard envelope and `Retry-After` seconds)
Public routes: per IP (`PUBLIC_RATE_LIMIT_MAX`, upload routes derived from it). Login: `LOGIN_RATE_LIMIT_MAX` per IP plus failed-attempt lockouts. Authenticated surfaces use one bucket **per session** (IP fallback), per minute: shop reads/queue/settings/pricing GET/qr/analytics + `GET /auth/session` 600; status transitions 120; print-confirmation 60; document-access 60; settings + pricing-rule mutations + logout 60; admin reads 600; admin mutations 60; SSE connects 30. Each shop/admin scope also has a per-IP ceiling of 5x the read limit (covers anonymous floods). Env: `RATE_LIMIT_SHOP_READ_MAX`, `RATE_LIMIT_STATUS_MAX`, `RATE_LIMIT_PRINT_CONFIRM_MAX`, `RATE_LIMIT_DOCUMENT_ACCESS_MAX`, `RATE_LIMIT_SHOP_MUTATION_MAX`, `RATE_LIMIT_ADMIN_READ_MAX`, `RATE_LIMIT_ADMIN_MUTATION_MAX`, `RATE_LIMIT_SSE_CONNECT_MAX`, `SSE_MAX_CONNECTIONS_PER_SHOP` (effectively unlimited when `NODE_ENV=test`). Counters are per process (single API instance).

## Health
`GET /health` (liveness; no DB). `GET /ready` (readiness): `200 { data:{status:"ready"} }` when `SELECT 1` succeeds within 2s, else `503 { error:{ code:"INTERNAL_ERROR", message:"Database unavailable", requestId } }` (no driver text). Storage reachability is not part of readiness. Use `/health` for container healthchecks.

## Validation error details
`details` on `VALIDATION_ERROR` is Zod's flattened `{ formErrors, fieldErrors }` with echoed input removed (e.g. `received 'x'` is stripped), so passwords/tokens are never reflected.

## Configuration notes
New env: `QUOTE_SECRET`, `QUOTE_TTL_SECONDS`, `STORAGE_URL_SECRET`, `PUBLIC_API_BASE`, `TRUST_PROXY`, `JSON_BODY_LIMIT_BYTES`, `COOKIE_SAMESITE`, `LOGIN_RATE_LIMIT_MAX`, `LOGIN_FAIL_MAX`, `LOGIN_FAIL_WINDOW_MINUTES`, `PUBLIC_RATE_LIMIT_MAX`, `SSE_HEARTBEAT_MS`, `DOCUMENT_CLEANUP_*`, `S3_*` (required only when `STORAGE_DRIVER=s3`). `NODE_ENV=production` (API **and** worker) fails closed with a list of problems unless: `SESSION_SECRET`, `CSRF_SECRET`, `QUOTE_SECRET` (and `STORAGE_URL_SECRET` for the local driver) are set, >= 32 chars, distinct and non-placeholder; `DATABASE_URL` has no default password; `WEB_ORIGIN` is https and not localhost; `TRUST_PROXY` or `TRUST_PROXY_CIDRS` is set explicitly (prefer `TRUST_PROXY_CIDRS=loopback,linklocal,uniquelocal` behind Caddy); `S3_*` are complete (https endpoint) when `STORAGE_DRIVER=s3`; `STORAGE_DRIVER=local` needs `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true`; `SSE_HEARTBEAT_MS <= 25000`. `UPLOAD_MAX_BYTES` (default 50 MiB) may not exceed 100 MiB; the reverse-proxy body cap must be >= `UPLOAD_MAX_BYTES` + 1 MiB. See `.env.example`.

## Contract evolution
Additive optional fields are preferred; breaking changes require an explicit versioning decision. Not yet implemented: automated subscription/payment integration, QR image generation (client-side), cross-process SSE fan-out.
