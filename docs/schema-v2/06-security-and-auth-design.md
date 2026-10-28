# 06 – Security and auth design (proposed)

## Why the PDF token model is not adopted

The PDF sends a Firebase ID token on every call. The repository issues its own short-lived access token and a single-use rotating refresh token bound to an installation id, with reuse detection, replay protection on Firebase `auth_time`, per-family revocation and Admin TOTP. Sending raw ID tokens to every route would remove revocation, device binding and the rotation guarantees. Decision AD-3: keep the current model for all clients; Firebase stays an identity proof exchanged once.

## Flows

| Client | Flow |
|---|---|
| Customer Android (proposed) | Firebase Google or phone OTP, then `POST /auth` with `installationId`; response is an access and refresh pair with principal `CUSTOMER`. Refresh via `POST /auth/refresh`. Logout `POST /auth/logout`. |
| Shop-owner Android (live) | Unchanged: `POST /auth` (Google, OTP, email+password). Multi-shop adds `GET /shops/mine`; the selected shop is a path parameter checked against `Membership`. |
| Web shop dashboard (live) | Cookie session + `X-CSRF-Token`. Legacy `/shop/*` uses the default shop. |
| Admin panel (live) | Password + TOTP 2FA (`printout_2fa` challenge), web only. New verify/block actions require the existing admin session and re-auth rules. |
| Windows Agent (live, untouched) | Device credential `pbd_...`; no user token. |

## Rules

1. Identity linking is explicit and re-authenticated; email or phone equality never links or signs in. The PDF steps "claim record by phone" and "reuse user by phone" are not implemented.
2. A person who is both customer and owner uses separate role grants on one account only after an explicit link; otherwise two accounts.
3. Tenant isolation: every `/shops/{shopId}/...` handler resolves `shopId` through `Membership(userId)`; failure is 403/404 without disclosing existence. Customers only see their own orders (`customerUserId`).
4. Customer-visible shop payloads exclude owner email, phone of owner, device and billing data.
5. Suspended accounts: existing `ACCOUNT_BLOCKED` behaviour; add `User.isActive` check for customers on login and refresh.
6. FCM: a token already registered to another user is **not** silently reassigned. The old registration is revoked only after the new principal authenticates in the same request, the action is audited, and registrations are keyed by `(userId, installationId)` as today. (The PDF's "reassign" is acceptable only under this rule.)
7. Uploads: type allowlist by magic bytes, size cap, object-key prefix bound to the authenticated principal, existence HEAD check, no cross-user or cross-shop reuse of a key.
8. Payments: a submitted UTR is an unverified claim, never proof. No automatic `paid`. Shop owner only sets `paid`. Refunds need a defined permission (proposed: admin only, as in the PDF). No card, PIN or bank credentials are stored.
9. Reviews: customer of a completed order only; text escaped on render; per-user rate limit.
10. Audit: every privileged change records actor, target, before and after in `AuditLog.metadata`. Append-only enforcement is an open decision.
11. Rate limits: add buckets for customer read, customer mutation, presign (per hour), review.
