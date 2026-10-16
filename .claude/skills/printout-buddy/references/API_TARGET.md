# Approved target API surface and contract gaps

**Source:** architecture PDF p1 `API surface` and `Agent WebSocket messages`, p7–11 data flows. This is a **route inventory**, not a complete OpenAPI spec: bodies, exact response fields, status codes, security schemes and versioning details are not fully given in the PDF. Never fabricate a definitive OpenAPI contract from these rows.

| Method | Target path | Actor | Purpose |
|---|---|---|---|
| GET | `/s/{slug}` | Customer | Shop profile, rates, availability |
| POST | `/v1/shops/{shopId}/sessions` | Customer | Anonymous 2-hour session |
| POST | `/v1/jobs` | Customer | Create print job, settings and file list; signed chunk URLs |
| POST | `/v1/documents/{docId}/complete` | Customer | Complete upload with SHA-256/parts |
| GET | `/v1/jobs/{jobId}/events` | Customer | SSE status feed |
| GET | `/v1/jobs/{jobId}` | Customer | Polling fallback |
| POST | `/v1/jobs/{jobId}/cancel` | Customer | Cancel if permissible |
| POST | `/v1/agent/pair` | Agent | Pair with one-time code |
| GET | `/v1/agent/ws` | Agent | Authenticated outbound WebSocket upgrade |
| GET | `/v1/shop/jobs?status=queued` | Shop | Today's queue |
| GET | `/v1/shop/jobs/{jobId}/preview` | Shop | Low-resolution page-one preview only |
| POST | `/v1/shop/jobs/{jobId}/print` | Shop | Dispatch selected printer / retry |
| POST | `/v1/shop/jobs/{jobId}/cancel` | Shop | Cancel/delete where allowed |
| PUT | `/v1/shop/rate-card` | Owner | Prices |
| POST | `/v1/shop/agents/pairing-codes` | Owner | Generate agent pairing code |
| GET | `/v1/shop/billing` | Owner | Subscription/invoices; hidden from staff |
| POST | `/v1/billing/webhooks/gateway` | Gateway | Signed, idempotent payment events |
| GET | `/v1/admin/shops` | Admin | Search shops |
| GET | `/v1/admin/agents?status=offline` | Admin | Agent health |
| GET | `/v1/admin/deletion-receipts` | Admin | Deletion audit, metadata only |
| POST | `/v1/admin/shops/{shopId}/suspend` | Admin | Suspend/restore with audit log |

## Agent WSS message inventory (PDF p1)

- agent→server: `hello`, `heartbeat`, `job.claim`, `job.progress`, `deletion.receipt`, `printer.status`
- server→agent: `job.offer`, `job.abort`, `agent.update`
- server response to claim: `job.lease` or `job.taken`; receipt acknowledgment: `receipt.ack`

Explicit target rules: agent only calls outward; heartbeat every 25 seconds; 90-second renewable lease; offer does **not** contain file URL; signed GET delivered after successful claim (2-min lifetime); receipt idempotency via receipt ID; keep local receipt outbox offline; do not automatically reprint ambiguous jobs.

## API design deliverables to generate before coding

1. OpenAPI 3.x draft with operation IDs, exact request/response schemas, validation limits, error codes, pagination and auth requirements; all PDF-unspecified details clearly marked `TBD` and sent for approval.
2. AsyncAPI or documented WebSocket protocol schema with sequencing, idempotency, reconnection, lease renewals and error behavior.
3. Compatibility map for existing Fastify `/api/v1/...` endpoints and consumers (web/Android).
4. Security/threat review: tenancy checks, anonymous tracking authority, CSRF as applicable, OTP replay, payment webhook signatures, admin prohibition on document access, signed URL scope and expiry.
5. Contract tests, lifecycle/lease concurrency tests and failover tests.

**Important:** current API routes are not automatically aligned with this PDF. Never announce new routes as live until implemented and tested.
