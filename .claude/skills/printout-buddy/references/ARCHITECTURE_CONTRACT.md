# Approved target architecture — source-bound digest

**Primary source:** `PrintoutBuddy Architecture.pdf`, pages 1–13. This is a *proposed first production-version architecture approved by the project owner*; numerical values in the PDF are targets, not measured performance. Current audited code differs materially.

## System
- Customer PWA; shop owner/staff dashboard; platform admin (PDF p1, p3–5).
- Kotlin/JVM 21 + Ktor API; PostgreSQL 16 system of record; Redis 7 queues/pubsub/rate limiting; S3-compatible encrypted object storage in India; CDN/WAF; background converter/scanner/deletion/notification workers (p1).
- Windows print agent installed as outbound-only service: WebSocket, claim lease, signed download, Windows spooler, temp/spool wipe, deletion receipt, offline outbox (p1, p8–9).
- Browser customers anonymous; owners use OTP; platform/shop permissions segmented; admins cannot read document bytes (p1).

## Security and lifecycle invariants
- At most 10 documents/job, 25 MB/document, 200 total pages/job (p1).
- Uploaded content expires at 60 minutes after first upload unless deleted sooner; printed bytes deleted on receipt; PDF specifies target sweeper/object deletion timings (p1–2).
- Job claim is atomic and idempotent; lease 90 seconds, renewed by heartbeat; no automatic reprint on uncertain spool outcome (p1).
- Signed PUT URLs 15 minutes, signed GET 2 minutes and only after valid claim; encryption in transit and at rest; no document content in SQL (p1).
- Store metadata and deletion receipts according to reviewed retention policy; PDF proposes one year and flags need for legal review (p1–2).
- Bill via UPI Autopay/processor webhooks with idempotency (p1, p10).

## Current-vs-target warnings from Codex audit (2026-10-16)
- As-is API is TypeScript/Fastify and Prisma, not Ktor.
- As-is owner login is password/session-based, not OTP/JWT.
- As-is shop device foundation is Android, not the required Windows print agent.
- As-is order/document relationship, retention policy and billing model do not match target.
- Unpublished local redesign, Android and email histories must be preserved.

## Open architecture decisions (do not silently decide)
- Technology migration sequence, transitional interoperability and deployed production baseline.
- Exact RPO/RTO engineering approach, payment provider, encryption/KMS operator, upload conversion pipeline and agent programming language (PDF offers Kotlin or .NET).
- Approved physical schema field types, detailed error codes, external auth provider and request body contracts.
