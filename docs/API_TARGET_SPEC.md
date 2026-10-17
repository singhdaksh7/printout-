# Target API specification and compatibility map

Sources: `PrintoutBuddy Architecture.pdf` p1 (API surface, Agent WebSocket messages, lifecycles), `docs/API_CONTRACT.md` and `docs/openapi/current.yaml` (verified current behaviour). The PDF gives routes, actors and purposes only; request/response bodies the PDF does not state are marked **TBD** and need approval. Live behaviour is the current Fastify API under `/api/v1`. Nothing in the "Planned" or "Blocked" rows exists, and no placeholder routes were added.

## Conventions (current, preserved)

| Topic | Rule |
|---|---|
| Base path | `/api/v1`; `/health` and `/ready` at the root |
| Success envelope | `{ "data": <payload> }` |
| Error envelope | `{ "error": { "code", "message", "requestId", "details"? } }`; codes include `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `INVALID_STATUS_TRANSITION` and the domain codes in `API_CONTRACT.md` |
| Validation | zod; failures return 400 `VALIDATION_ERROR` with `details.fieldErrors` (submitted values are never echoed) |
| Pagination | cursor: `?cursor=<opaque>&limit=1..100` (default 50); response `{ items, nextCursor? }` |
| Auth: owner/admin | cookie `printout_session` (HttpOnly, SameSite=Lax) plus a CSRF token header on mutations |
| Auth: device | `Authorization: Bearer <device credential>`; only a SHA-256 digest is stored |
| Auth: customer | none today; the tracking token authorises one order |
| Idempotency | mutations carry a client-generated `clientRequestId` (uuid) |
| Tenancy | `shopId` comes from the session or device credential only |
| Admin | metadata only; no route returns document bytes or URLs to an admin |
| Upload limit | API default 50 MB (`UPLOAD_MAX_BYTES`); PDF target is 25 MB per document, 10 documents and 200 pages per job (not enforced yet) |

## Endpoint implementation status

**Implemented**: live with the same intent. **Partial**: an equivalent exists with a different shape or scope. **Planned**: specified by the PDF, no code. **Blocked**: needs a decision or an out-of-scope component.

| Target endpoint (PDF) | Actor | Status | Current equivalent / note |
|---|---|---|---|
| `GET /s/{slug}` | Customer | Partial | `GET /public/shops/{slug}` returns name, rates, open state, retention minutes; the customer page is the web app at `/p/{slug}` |
| `POST /v1/shops/{shopId}/sessions` | Customer | Planned | No customer sessions; model `CustomerSession` exists, unused. Today anonymous and order-scoped by tracking token |
| `POST /v1/jobs` | Customer | Partial | `POST /public/shops/{slug}/uploads/initiate`, then `/quotes`, then `/orders` (one document per order, single PUT, not chunked) |
| `POST /v1/documents/{docId}/complete` | Customer | Partial | `POST /public/shops/{slug}/uploads/{uploadId}/complete` (server counts pages; no client sha256/part list) |
| `GET /v1/jobs/{jobId}/events` | Customer | Planned | Customers poll `GET /public/orders/{token}`; SSE exists only for shops (`GET /shop/events`) |
| `GET /v1/jobs/{jobId}` | Customer | Implemented (as Order) | `GET /public/orders/{token}` |
| `POST /v1/jobs/{jobId}/cancel` | Customer | Planned | No customer cancel; shops cancel via transitions |
| `POST /v1/agent/pair` | Agent | Partial | `POST /device/pair` pairs an Android device; the Windows agent is out of scope |
| `GET /v1/agent/ws` | Agent | Blocked | Windows Print Agent not implemented (protocol below) |
| `GET /v1/shop/jobs?status=queued` | Shop | Implemented (as Order) | `GET /shop/orders?status=&print=&cursor=&limit=` |
| `GET /v1/shop/jobs/{id}/preview` | Shop | Partial | Short-lived document access (`POST /shop/orders/{id}/document-access`) exists; a page-1 low-resolution preview image does not |
| `POST /v1/shop/jobs/{id}/print` | Shop | Implemented (as Order) | `POST /shop/orders/{id}/print-now`; device print/reprint under `/device/orders/{id}/...`. No printer selection or retry-to-queue |
| `POST /v1/shop/jobs/{id}/cancel` | Shop | Implemented (as Order) | `POST /shop/orders/{id}/transitions` with `toStatus=CANCELLED` |
| `PUT /v1/shop/rate-card` | Owner | Implemented (different shape) | `GET/POST/PUT/DELETE /shop/pricing-rules` |
| `POST /v1/shop/agents/pairing-codes` | Owner | Implemented (Android devices) | `POST /shop/devices/pairing-codes`; list, rename and revoke under `/shop/devices` |
| `GET /v1/shop/billing` | Owner | Blocked | No billing, payments or invoices are enabled; tables exist, unused |
| `POST /v1/billing/webhooks/gateway` | Gateway | Blocked | Payment provider not chosen; payment processing deliberately off |
| `GET /v1/admin/shops` | Admin | Implemented | `GET /admin/shops` (plus create, update, detail) |
| `GET /v1/admin/agents?status=offline` | Admin | Planned | Needs agent presence data; device presence exists per shop only |
| `GET /v1/admin/deletion-receipts` | Admin | Blocked | No receipts are produced (no agent); table exists, unused |
| `POST /v1/admin/shops/{id}/suspend` | Admin | Implemented (different shape) | `PUT /admin/shops/{id}` with `status` (audit-logged, ends the shop's sessions) |

Current routes with no PDF counterpart (kept): `/auth/login|logout|session`, `/shop/settings`, `/shop/qr`, `/shop/analytics`, `/shop/events`, `/shop/orders/{id}/print-confirmation|document-download`, device self routes (`/device/heartbeat|push-token|me`), admin dashboard, orders, plans, subscriptions and audit-logs, and admin self-service account routes (`GET /admin/account`, `POST /admin/account/email|password`).

## Compatibility rules

1. Existing routes, bodies and the `{ data }` / `{ error }` envelopes do not change; web and Android clients depend on them.
2. Target `/v1/...` names are not added as aliases until the underlying entity (`PrintJob`) is authoritative.
3. Where an equivalent is "Partial", the target route is introduced beside the current one, never instead of it, with a deprecation window.

## Agent WebSocket protocol (specification for future work, not implemented)

Transport: the agent dials out over WSS to `GET /v1/agent/ws` with a short-lived ticket obtained after pairing; the server never connects in. Messages are JSON `{ "type", "seq", ... }` with a monotonically increasing `seq` per direction.

| Direction | Message | Payload |
|---|---|---|
| agent to server | `hello` | agent id, version, printers with capabilities, outbox size |
| agent to server | `heartbeat` | every 25 s; renews any active lease |
| server to agent | `job.offer` | job id, printer id, settings, page count (no file URL) |
| agent to server | `job.claim` | job id; answered by `job.lease` (lease id, signed GET URLs) or `job.taken` |
| agent to server | `job.progress` | `spooled`, `printed` or `failed` with printer error code |
| agent to server | `deletion.receipt` | receipt id, document id, sha256, wipe flags, local time; acked by `receipt.ack` |
| agent to server | `printer.status` | online, paper out, jam, offline |
| server to agent | `job.abort` | shop cancelled; stop the spool job if possible |
| server to agent | `agent.update` | version URL and signature |

Rules from the PDF: lease 90 s renewed by heartbeat; a claim is one atomic SQL update, so a second claim gets `job.taken`; the signed GET lives 2 minutes and is issued only after a valid claim; receipts are accepted once per receipt id and queued in a local outbox while offline; no automatic reprint after an uncertain outcome; expiry decisions use server time only. **TBD:** ticket format, reconnect/backoff, error codes, `seq` gap handling, printer ids.

## Lifecycle and retention contracts

Current (live): print initiation starts retention; the document is deleted when `deleteAfter` passes (retention minutes come from the API) by the cleanup worker; `Order` and `Document` statuses are independent; metadata is kept indefinitely.

Target (PDF, not live): content deleted right after print or 60 minutes after first upload; object deleted within 60 s of receipt; unprinted expiry swept within 2 minutes of the 60-minute mark; PrintJob `uploading, queued, printing, printed, failed, cancelled, expired`; Document `uploaded, scanned, ready, claimed, spooled, deleted` with `rejected` and `expired` exits; metadata and receipts kept one year then deleted, subject to legal review. Automatic one-year deletion is **not** activated.
