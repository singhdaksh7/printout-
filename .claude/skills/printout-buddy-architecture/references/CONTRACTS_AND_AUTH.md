# Contracts and authentication

## CURRENT_PRODUCTION (verify in `docs/architecture/api-inventory.md` or code before quoting)

- Base URL `https://printoutbuddy.tech/api/v1`. Success `{ "data": ... }`; error `{ "error": { code, message, requestId, details } }`. Request bodies are strict (unknown keys give 400). Money is integer paise; dates ISO UTC; business day Asia/Kolkata.
- **Android bearer contract**: `POST /auth` (Firebase Google/phone ID token or email+password, plus `installationId` and `platform`) returns an access token (15 min default) and a single-use rotating refresh token (30 days default). `POST /auth/refresh` takes `{ refreshToken, deviceId }` (deviceId equals installationId); reuse beyond a 5 s grace revokes the whole family; concurrent refresh returns 409 `REFRESH_CONFLICT`. `POST /auth/logout` revokes the family and the installation's FCM registration. Bearer requests are exempt from CSRF. A restricted onboarding principal (identity with no account) may only call `POST /shops/onboarding`, `GET /users/me` and logout.
- Web: `printout_session` cookie plus `X-CSRF-Token` on POST/PUT/PATCH/DELETE. Admin: password then TOTP (`printout_2fa` challenge), web only.
- Device (Windows Agent / Android print device): `Authorization: Bearer pbd_...` from `POST /device/pair`; routes under `/device/*` (orders, print-jobs claim/progress/download, printers, heartbeat, credential rotate, push-token).
- Guest customer flow: `GET /public/shops/:slug`, `POST /public/shops/:slug/quotes`, `POST .../uploads/initiate` + upload PUT (HMAC token), `POST /public/shops/:slug/orders`, `GET /public/orders/:token` (tracking token is the capability).
- Owner: `/shop/*` (settings, pricing-rules, orders, history, hours, notifications, events SSE, devices), `/shops/me`, `/users/me`, `/users/me/fcm-token`, identity linking under `/users/me/identities`.
- Admin: `/admin/shops`, `/admin/shops/:id`, `/admin/plans`, `/admin/subscriptions`, `/admin/audit-logs`, `/admin/orders`, `/admin/dashboard`.

## Rules for anything new

1. The PDF auth model (Firebase ID token in the `Authorization` header of every call) is **not** adopted (PROPOSED decision AD-3). Customers, if approved, use the same exchange-then-bearer flow with a CUSTOMER principal.
2. Identity: resolved only by Firebase uid via the identity tables; matching email/phone never links or signs in. Linking is explicit and re-authenticated. Admin create never reuses a user by phone.
3. Nullable email (decision D5, pending): allowed only for CUSTOMER rows, enforced by a database check; owner and admin keep email + password rules.
4. FCM: tokens stored encrypted with a hash; a token seen under another user is revoked from the old owner only after the new principal is authenticated, and audited; never returned by any API.
5. Every `/shops/{shopId}/...` route resolves `shopId` via `Membership`; customers only access orders where `customerUserId` is theirs.
6. New routes: strict schema, own rate-limit bucket, audit for privileged actions, `Idempotency-Key` on creates.
7. Status of PDF endpoints: see `docs/schema-v2/05`. Only rows labelled CURRENT_LIVE exist; NEW_PROPOSED and BLOCKED rows must not be described as available (for example the customer file download is BLOCKED while retention is 30 minutes).
