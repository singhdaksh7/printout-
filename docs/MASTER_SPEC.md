# Printout master specification

**Status:** frozen foundation specification, 3 October 2026. Changes require an explicit documented decision.

## Purpose and actors

Printout is a ₹99/month-per-shop SaaS for print shops. A shop displays a permanent QR code leading to its unique public slug (`/p/{shopSlug}`). Customers do not create accounts. Shop users authenticate to a mobile-first operational dashboard. V1 roles are `SHOP_OWNER` and `PLATFORM_ADMIN` only; employee, cashier, and operator roles are not introduced. Platform admins administer shops, manual plan/subscription state, and support/audit views.

## Customer journey

1. Scan a shop QR and open its public page.
2. Upload exactly one document for that prospective order: PDF, JPG/JPEG, or PNG.
3. Configure A4 printing: B&W or colour; single-sided or duplex; copies; all pages or a validated custom range.
4. Request an API quote. The API loads that shop's active pricing and returns the authoritative amount.
5. Review and submit the order; pay the displayed amount to the shop using its existing payment method.
6. Optionally provide a display name/reference; no phone number is collected.
7. Track the live order with a non-guessable opaque public tracking token, never by using a sequential order number as authorization. There is no online payment in V1.

## Shop journey

Authenticated shop users receive queue updates without refresh (SSE preferred). They inspect each order and its print configuration, use an authorized temporary document view/print workflow, and move it through the permitted lifecycle. Browser/system print is V1's printing method. A successful print must be explicitly confirmed before the privacy clock starts.

## Upload policy

V1 permits exactly one document per order: PDF, JPG/JPEG, or PNG. The V1 defaults are a 50 MB maximum file size and a maximum of 200 PDF pages. One uploaded JPG/JPEG/PNG always represents one printable page. Successful upload completion begins the 24-hour unprinted-document expiry, even if an order is never submitted. These limits must be environment/configurable when implemented, with the stated values as defaults.

## Print configuration and pricing

V1 supports only A4. `colourMode` is `bw | colour`; `sides` is `single | duplex`; copies are positive integers; pages are `all` or a normalized, validated range selection. PDF page count is determined server-side; image documents count as one page unless rendering rules later define otherwise.

Pricing is always server-authoritative. An order persists a complete pricing and print-option snapshot, so later configuration changes never change an existing order. Each active pricing rule is deterministic: `{ paperSize: "A4", colourMode, sides, pricePerSheetPaise }`. For each selected page count and copy count, the backend computes `sheetsPerCopy` (`pages` for single-sided; `ceil(pages / 2)` for duplex), then `totalSheets = sheetsPerCopy × copies`, and `totalPaise = totalSheets × pricePerSheetPaise`. The remaining business-semantic question to validate in pilot feedback is whether shops want duplex charged per physical sheet (this V1 rule) or per document page; V1 uses the former and does not silently reinterpret it.

## Order lifecycle

The only normal forward path is `NEW → ACCEPTED → PRINTING → PRINTED → READY → COLLECTED`.

`NEW → CANCELLED` and `ACCEPTED → CANCELLED` are the only V1 cancellation transitions. `CANCELLED` and `EXPIRED` are terminal. `EXPIRED` applies where appropriate before successful printing, including expiry associated with an available unprinted document. The backend exclusively owns and validates this transition policy; clients cannot select arbitrary transitions. Every transition is tenant-authorized and appended to status history.

## Document lifecycle and privacy

Document state is separate from order state. Documents live only in private S3-compatible object storage, never as PostgreSQL blobs. Object keys are random and have no customer-identifying path components. The primary lifecycle states are `UPLOADING`, `AVAILABLE`, `PRINTED_RETENTION`, and `DELETED`, with implementation-defined failure states where technically necessary. Documents have metadata, checksum, detected MIME, byte size, page count where available, and lifecycle timestamps.

- A document is not scheduled for 30-minute deletion merely when a browser print dialog opens.
- When a shop explicitly confirms successful printing, the API writes `printedAt` at the server confirmation timestamp, sets `deleteAfter = printedAt + exactly 30 minutes`, and moves the document to `PRINTED_RETENTION`.
- Until `deleteAfter`, an authorized shop user may reprint and the UI may show a countdown.
- Reprinting never extends or resets `deleteAfter`: if printed at 17:00 and reprinted at 17:20, deletion remains scheduled for 17:30.
- At/after `deleteAfter`, a retry-safe job permanently deletes the storage object, changes the document to `DELETED`, and makes it inaccessible. It records deletion metadata (`deletedAt`, deletion state/attempt details) while keeping safe order metadata. An order may still progress to `READY` or `COLLECTED` independently after document deletion.
- Unprinted/abandoned documents expire exactly 24 hours after successful upload completion, including orphaned uploads for which order submission never succeeds. They must be deleted by the same idempotent process.

No backup policy may silently retain accessible customer document objects beyond this privacy promise. Deletion is observable, retry-safe, and idempotent; a missing object is treated as successfully deleted after verification.

## Multi-tenancy

This is one shared platform, database, and deployment. Every shop-owned record carries a tenant/shop identity and every authenticated query is scoped from the server-derived session tenant, never a client-provided shop ID. Public routes resolve the shop only by unique active slug. Cross-tenant references are rejected. Database constraints, indexes, service authorization, and tests reinforce isolation.

## Security principles

Public lookup/upload/order endpoints are hostile surfaces: strict Zod validation, route-specific rate limits, request/body and upload-size limits, MIME plus file-signature validation, filename/path neutralization, and rejection of executables are mandatory. Storage is private; object access uses short-lived authorized mechanisms only—never permanent public URLs. Use Argon2id passwords, HttpOnly/Secure/SameSite cookies, CSRF protection for cookie-authenticated mutation, security headers, authorization checks, audit logs for sensitive shop/admin actions, and no secret logging. Antivirus/malware scanning must not be claimed until implemented.

## MVP scope

Shared multi-tenant application; public QR shop pages; upload and quote; order submission/tracking; shop-owner authentication; live queue; configuration/pricing; status handling; browser print workflow; document lifecycle jobs; basic platform-admin operations including manual subscription state; and operational auditability.

## Explicitly out of scope for V1

Online customer payment, automated subscription/payment integration, customer accounts, customer phone collection, employee/cashier/operator roles, universal Bluetooth/direct printer integrations, automatic printing, a Windows agent, microservices, separate per-shop deployments/databases, storing documents in PostgreSQL, and unimplemented claims of malware scanning.

## Future Print Agent

A future, opt-in Windows Print Agent may authenticate a shop device and automate delivery to a local printer. It is not designed, exposed, or required in V1. Its future protocol must preserve tenant authorization, explicit shop control, document privacy, and auditability.
