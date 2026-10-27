# API inventory (all registered routes)

> Source of truth: the Fastify route registrations in `apps/api/src` on `origin/main` (commit `080c6bd`). Every row below was transcribed from code; the route list is cross-checked mechanically against a scan of the sources (see [README](./README.md#how-this-was-verified)).
> **113 registered routes** (111 under `/api/v1` + `/health` and `/ready`). **1 retired** (documented as deprecated, not active).

## Conventions

**Base URL (production):** `https://printoutbuddy.tech/api/v1` (`/health` and `/ready` live at the root of the same host).

**Success envelope:** `{ "data": <payload> }`. Exceptions: `204 No Content` (no body), CSV exports, the SSE stream, and the raw upload/download bytes.

**Error envelope (every non-2xx):**
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed", "requestId": "<uuid>", "details": { } } }
```
`code` is a stable machine value (see the list in [android-integration-guide.md](./android-integration-guide.md#error-handling-and-retries)); `message` is human text and may change; `requestId` is also what support needs. `details` is present only for some errors (validation `fieldErrors`, `details.nextStep = "account_blocked"`, `details.maxBytes`, `details.nextOpenAt` for `SHOP_CLOSED`).

**Unknown routes** → `404 NOT_FOUND`. **Never cached:** every response carries `Cache-Control: no-store` unless a route sets otherwise.

**Strict bodies:** almost every request body is a strict schema: unknown keys → `400 VALIDATION_ERROR`. Do not send extra fields. (Exceptions: `POST /shops/onboarding` ignores unknown keys.)

**Dates** are ISO-8601 UTC strings. **Money** is integer **paise** (`pricePerSheetPaise`, `totalPaise`; currency always `INR`). **Ids** are opaque strings (cuid; document ids are 24-char random). Business days are **Asia/Kolkata**.

### Authentication mechanisms

| Key | Mechanism |
|---|---|
| None | Unauthenticated. Per-IP rate limit. |
| Owner session | Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| Any session | Any signed-in user (owner or admin). Bearer, or cookie + `X-CSRF-Token` on non-GET. |
| Session or restricted grant | A full session (owner/admin) or the restricted onboarding principal (verified Google/phone identity with no account yet). |
| Restricted onboarding grant | Android: the restricted `accessToken` returned by `POST /auth` when `nextStep = create_shop` (sent as `Authorization: Bearer`). Web: `printout_onboarding` cookie. Not a session. |
| Admin session | `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| Device credential | `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| Pending 2FA challenge cookie | `printout_2fa` cookie (path `/api/v1/auth/login/2fa`) issued by `/auth/login` for admins with 2FA. Not a session. |
| Signed URL | HMAC `exp` + `sig` query parameters issued by the API (local storage driver only). |
| Upload token | `token` query parameter from `uploads/initiate` (HMAC, 15 min, single use). |
| Session, or refresh token in body | Owner session (Bearer / cookie + CSRF), or a restricted grant, or `{ refreshToken }` in the body when the access token already expired. |
| Tracking token (path) | The unguessable `trackingToken` in the URL is the capability. |

Owner routes accept **either** transport: Android uses `Authorization: Bearer` and is **exempt from CSRF**; a browser uses the cookie and must send `X-CSRF-Token` on every POST/PUT/PATCH/DELETE (`403 CSRF_INVALID` otherwise). The **Firebase ID token is never accepted by `/shop/*`, `/users/*`, or `/shops/*`**: it is only exchanged at `POST /auth` (or the web equivalents).

### Rate limits (code defaults, per process, per minute)

| Bucket | Limit | Key |
|---|---|---|
| Login/exchange/onboarding (`LOGIN_RATE_LIMIT_MAX`) | 10 | client IP |
| Refresh | 30 | client IP (+ 60 per refresh family) |
| Public (`PUBLIC_RATE_LIMIT_MAX`) | 60 (uploads/initiate 20, upload PUT 30) | client IP |
| shopRead | 600 | session id |
| shopMutation | 60 | session id |
| status (transitions, print-now) | 120 | session id |
| documentAccess | 60 | session id |
| shopExport (CSV) | 6 | session id |
| sseConnect | 30 | session id |
| deviceRead / deviceMutation | 300 / 120 | device id |
| devicePair | 10 | client IP |
| adminRead / adminMutation | 600 / 60 | session id |
| IP ceiling in front of every guarded scope | 3000 (= shopRead × 5) | client IP |

Exceeded → `429 RATE_LIMITED` with a `Retry-After` header (seconds). Counters are in memory on the single API process. The production values of the `RATE_LIMIT_*` env overrides are **Requires confirmation** (they may differ from the defaults).

### Status labels used below

| Label | Meaning |
|---|---|
| **Verified from code** | Method, path, guards, schemas and error codes were read from the route source on `main`. |
| **Deprecated** | Registered but retired: it answers an error and must not be called. |
| **Not implemented** | Planned in docs/API_TARGET_SPEC.md but absent from the code: listed in [Not implemented](#not-implemented-do-not-call). |
| **Requires confirmation** | Behaviour depends on production configuration or an inner shape that is not pinned by a schema. |


## 1. Authentication and onboarding

| Method | Path | Auth | Android |
|---|---|---|---|
| POST | `/api/v1/auth` | None | YES |
| POST | `/api/v1/auth/refresh` | None | YES |
| POST | `/api/v1/auth/logout` | Session, or refresh token in body | YES |
| POST | `/api/v1/auth/logout-all` | Any session | YES |
| GET | `/api/v1/auth/session` | Any session | NO |
| POST | `/api/v1/auth/login` | None | NO |
| POST | `/api/v1/auth/login/2fa` | Pending 2FA challenge cookie | NO  |
| POST | `/api/v1/auth/login/2fa/cancel` | None | NO  |
| POST | `/api/v1/auth/google/session` | None | NO |
| POST | `/api/v1/auth/phone/session` | None | NO |
| GET | `/api/v1/auth/phone/config` | None | Optional  |
| POST | `/api/v1/auth/firebase/exchange` | None | NO |
| POST | `/api/v1/shops/onboarding` | Restricted onboarding grant | YES  |
| GET | `/api/v1/users/me/identities` | Owner session | YES  |
| POST | `/api/v1/users/me/identities/google` | Owner session | YES  |
| POST | `/api/v1/users/me/identities/google/unlink` | Owner session | YES  |
| GET | `/api/v1/shop/account/phone` | Owner session | Optional |
| POST | `/api/v1/shop/account/phone` | Owner session | Optional |
| POST | `/api/v1/shop/account/phone/unlink` | Owner session | Optional |

### POST /api/v1/auth

Unified MOBILE sign-in. Exchanges a Firebase Google/phone ID token (or email+password) for a Bearer access token + rotating refresh token.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request JSON** | `{ loginMethod: "otp" \| "email" \| "google"; phoneNumber?: string; firebaseIdToken?: string; email?: string; password?: string; fcmToken?: string; installationId: string; platform: "android" \| "ios" \| "web" }`<br>`firebaseIdToken` (20-4096 chars) required for `otp` and `google`; `email`+`password` required for `email`. `installationId` = 16-64 chars `[A-Za-z0-9_-]`, random and stable per install. `fcmToken` is optional, registered only after authentication succeeds, and a push failure never fails sign-in. Body is strict (unknown keys → 400). |
| **Response JSON** | `{ data: MobileAuthResponse }` |
| **HTTP status** | success 200 |
| **Application errors** | 429 RATE_LIMITED, 400 VALIDATION_ERROR, 401 INVALID_CREDENTIALS (email), 401 GOOGLE_TOKEN_INVALID, 401 PHONE_TOKEN_INVALID, 403 FORBIDDEN (admin or non-owner), 403 ACCOUNT_BLOCKED (suspended shop, `details.nextStep=account_blocked`), 403 PHONE_REVERIFY_REQUIRED, 503 GOOGLE_LOGIN_UNAVAILABLE, 503 PHONE_LOGIN_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Not idempotent: each success revokes earlier token families of the same `installationId` and issues a new pair. A Firebase ID token can be exchanged once (replay protection on `auth_time`). |
| **Rate limit** | `LOGIN_RATE_LIMIT_MAX` = 10/min per IP; plus in-memory failed-login throttles (5 per IP+email / 15 min; account-wide 20). |
| **Tables read** | User, Shop, UserGoogleIdentity, UserPhoneIdentity, ShopSettings, Subscription, Plan, PricingRule, AuditLog |
| **Tables written** | Session, RefreshToken, PhoneOnboardingGrant (new identity), FcmRegistration (optional), UserGoogleIdentity/UserPhoneIdentity (lastAuthTime), User.lastLoginAt, AuditLog |
| **Android** | YES: the only Android sign-in endpoint. |
| **Notes** | A Google identity not linked to any account returns the **restricted pair** with `nextStep: "create_shop"` and `user.id: null`; use it only for `POST /shops/onboarding`, `GET /users/me` and logout. |

### POST /api/v1/auth/refresh

Rotate the refresh token: returns a new access token AND a new refresh token (single-use rotation with reuse detection).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request JSON** | `{ refreshToken: string; deviceId: string }`<br>`deviceId` must equal the `installationId` used at sign-in (16-64 chars). Body limit 4096 bytes; anything larger returns the same 401 as a forged token. Refresh token travels ONLY in the body. |
| **Response JSON** | `{ data: MobileAuthResponse }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 REFRESH_TOKEN_INVALID, 401 REFRESH_TOKEN_EXPIRED, 409 REFRESH_CONFLICT (concurrent/just-rotated, retry after the first finishes), 403 ACCOUNT_BLOCKED, 403 FORBIDDEN, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | — |
| **Idempotency** | Single-use. Re-presenting a rotated token within `REFRESH_REUSE_GRACE_SECONDS` (5) → 409 (nothing revoked); later → whole family revoked + 401. Always single-flight on the client. |
| **Rate limit** | 30/min per IP (`LOGIN_RATE_LIMIT_MAX*3`), per-family budget 60, failure throttle per IP. |
| **Tables read** | RefreshToken, User, Shop, UserPhoneIdentity, UserGoogleIdentity |
| **Tables written** | RefreshToken (rotatedAt / new row), Session (old invalidated, new created), AuditLog |
| **Android** | YES |
| **Notes** | A restricted (onboarding) refresh token stays restricted until the identity is linked to a user; the next refresh after onboarding yields a normal pair. 15 min access / 30 day refresh are the code defaults (`ACCESS_TOKEN_TTL_MINUTES`, `REFRESH_TOKEN_TTL_DAYS`); trust `expiresIn` / `refreshTokenExpiresIn` in the response. |

### POST /api/v1/auth/logout

End this session. For a mobile session also revokes its refresh family and the installation's FCM registration.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Session, or refresh token in body: Owner session (Bearer / cookie + CSRF), or a restricted grant, or `{ refreshToken }` in the body when the access token already expired. |
| **Role / scope** | any |
| **Request JSON** | `{ refreshToken?: string }`<br>Body optional. An expired-access-token app can still sign out by sending `{ refreshToken }` with no Authorization header (idempotent: unknown/revoked token → 204). |
| **Response JSON** | no body |
| **HTTP status** | success 204 |
| **Application errors** | 401 UNAUTHORIZED (no valid credential at all), 403 CSRF_INVALID (cookie), 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation 60/min per session. |
| **Tables read** | Session, RefreshToken, PhoneOnboardingGrant |
| **Tables written** | Session.invalidatedAt, RefreshToken.revokedAt, FcmRegistration (revoked), PhoneOnboardingGrant (deleted), AuditLog |
| **Android** | YES |

### POST /api/v1/auth/logout-all

Sign out of every device: ends all sessions and refresh families of the caller; removes push registrations unless `keepPush`.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Any session: Any signed-in user (owner or admin). Bearer, or cookie + `X-CSRF-Token` on non-GET. |
| **Role / scope** | any |
| **Request JSON** | `{ keepPush?: boolean }` |
| **Response JSON** | no body |
| **HTTP status** | success 204 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation 60/min per session. |
| **Tables read** | Session, RefreshToken |
| **Tables written** | Session, RefreshToken, FcmRegistration, AuditLog |
| **Android** | YES |

### GET /api/v1/auth/session

Web session probe: returns the web-shaped session payload including a fresh CSRF token.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Any session: Any signed-in user (owner or admin). Bearer, or cookie + `X-CSRF-Token` on non-GET. |
| **Role / scope** | any |
| **Request body** | none |
| **Response JSON** | `{ data: { user: { id: string; displayName: string; role: "SHOP_OWNER" \| "PLATFORM_ADMIN" }; shop: { id: string; slug: string; displayName: string } \| null; csrfToken: string; retentionMinutes: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe (GET). |
| **Rate limit** | shopRead 600/min per session. |
| **Tables read** | Session, User, Shop |
| **Tables written** | — |
| **Android** | NO: use `GET /users/me` (richer, same auth). |

### POST /api/v1/auth/login

WEB email+password sign-in (cookie session + CSRF token). Admins with 2FA get `{ twoFactorRequired: true }` plus a pending-challenge cookie instead of a session.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request JSON** | `{ email: string; password: string }` |
| **Response JSON** | `{ data: { user: { id: string; displayName: string; role: "SHOP_OWNER" \| "PLATFORM_ADMIN" }; shop: { id: string; slug: string; displayName: string } \| null; csrfToken: string; retentionMinutes: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 429 RATE_LIMITED, 400 VALIDATION_ERROR, 401 INVALID_CREDENTIALS, 403 SHOP_SUSPENDED, 503 TWO_FACTOR_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Not idempotent: rotates the cookie session. |
| **Rate limit** | 10/min per IP + failed-login throttle. |
| **Tables read** | User, Shop, AdminTwoFactor |
| **Tables written** | Session, AdminLoginChallenge, User.lastLoginAt, AuditLog |
| **Android** | NO: sets a cookie and returns a CSRF token. Use `POST /auth` with `loginMethod: "email"`. |

### POST /api/v1/auth/login/2fa

Second step of an admin sign-in (TOTP or recovery code).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Pending 2FA challenge cookie: `printout_2fa` cookie (path `/api/v1/auth/login/2fa`) issued by `/auth/login` for admins with 2FA. Not a session. |
| **Role / scope** | PLATFORM_ADMIN |
| **Request JSON** | `{ method: "totp" \| "recovery"; code: string }` |
| **Response JSON** | `{ data: { user: any; shop: any \| null; csrfToken: string; retentionMinutes: number; recoveryCodesRemaining?: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 429 RATE_LIMITED, 400 VALIDATION_ERROR, 401 INVALID_TWO_FACTOR_CODE, 401 TWO_FACTOR_CHALLENGE_INVALID, 503 TWO_FACTOR_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Challenge is single-use; each attempt is counted before the code is checked (max 5). |
| **Rate limit** | 10/min per IP. |
| **Tables read** | AdminLoginChallenge, AdminTwoFactor, AdminRecoveryCode, User |
| **Tables written** | AdminLoginChallenge, AdminTwoFactor.lastUsedStep, AdminRecoveryCode.usedAt, Session, AuditLog |
| **Android** | NO (admin web only) |

### POST /api/v1/auth/login/2fa/cancel

Abandon a pending admin 2FA challenge held by this browser.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request body** | none |
| **Response JSON** | no body |
| **HTTP status** | success 204 |
| **Application errors** | — |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | none beyond global. |
| **Tables read** | AdminLoginChallenge |
| **Tables written** | AdminLoginChallenge.consumedAt |
| **Android** | NO (admin web only) |

### POST /api/v1/auth/google/session

WEB Google sign-in: verified Firebase Google ID token → session cookie, or restricted onboarding cookie when no account is linked.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request JSON** | `{ idToken: string }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 429 RATE_LIMITED, 400 VALIDATION_ERROR, 401 GOOGLE_TOKEN_INVALID, 403 FORBIDDEN (bad Origin / admin), 403 SHOP_SUSPENDED, 503 GOOGLE_LOGIN_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Token single-use (`auth_time` replay check). |
| **Rate limit** | 10/min per IP + failure throttle. |
| **Tables read** | UserGoogleIdentity, User, Shop |
| **Tables written** | Session, PhoneOnboardingGrant, UserGoogleIdentity.lastAuthTime, AuditLog |
| **Android** | NO: use `POST /auth` (`loginMethod: "google"`). |

### POST /api/v1/auth/phone/session

WEB phone-OTP sign-in for an already-linked owner (cookie session). Does NOT create onboarding grants.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request JSON** | `{ idToken: string }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 429 RATE_LIMITED, 400 VALIDATION_ERROR, 401 PHONE_TOKEN_INVALID, 403 PHONE_NOT_LINKED, 403 PHONE_REVERIFY_REQUIRED, 403 SHOP_SUSPENDED, 503 PHONE_LOGIN_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Token single-use. |
| **Rate limit** | 10/min per IP. |
| **Tables read** | UserPhoneIdentity, User, Shop |
| **Tables written** | Session, UserPhoneIdentity.lastAuthTime, AuditLog |
| **Android** | NO: use `POST /auth` (`loginMethod: "otp"`). |

### GET /api/v1/auth/phone/config

Phone sign-in availability and allowed country codes.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request body** | none |
| **Response JSON** | `{ data: { enabled: boolean; allowedCallingCodes: string[]; defaultCallingCode: "+91"; resendCooldownSeconds: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | — |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | none beyond global. |
| **Tables read** | — |
| **Tables written** | — |
| **Android** | Optional (feature detection) |

### POST /api/v1/auth/firebase/exchange

Phone-OTP token exchange for web (cookie) or mobile (`client: "mobile"`, flat Bearer pair). Kept for the web app.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request JSON** | `{ idToken: string; client?: "web" \| "mobile"; deviceId?: string }`<br>`deviceId` required when `client = mobile`. `client` defaults to `web`. |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 429 RATE_LIMITED, 400 VALIDATION_ERROR, 401 PHONE_TOKEN_INVALID, 403 PHONE_REVERIFY_REQUIRED, 403 ACCOUNT_BLOCKED / SHOP_SUSPENDED, 503 PHONE_LOGIN_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Token single-use. |
| **Rate limit** | 10/min per IP. |
| **Tables read** | UserPhoneIdentity, User, Shop |
| **Tables written** | Session, RefreshToken, PhoneOnboardingGrant, AuditLog |
| **Android** | NO: `POST /auth` is the documented mobile entry (same logic). |

### POST /api/v1/shops/onboarding

Create the caller's shop (first-time Google/phone user). Creates User + Shop + ShopSettings + verified identity in ONE transaction and returns a full session/credential pair.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Restricted onboarding grant: Android: the restricted `accessToken` returned by `POST /auth` when `nextStep = create_shop` (sent as `Authorization: Bearer`). Web: `printout_onboarding` cookie. Not a session. |
| **Role / scope** | restricted principal |
| **Request JSON** | `{ ownerName: string; email?: string; shopName: string; address: string; pincode: string; client?: "web" \| "mobile"; deviceId?: string }`<br>`ownerName` 1-100; `shopName` 2-100; `address` 5-300; `pincode` `^[1-9][0-9]{5}$`. Google principals: `email` omitted or equal to the verified email; phone principals: `email` required. `client: "mobile"` requires `deviceId` (= the `installationId`). Unknown keys are NOT rejected (body is not strict). |
| **Response JSON** | `{ data: MobileAuthResponse }` |
| **HTTP status** | success 201 (created) / 200 (idempotent repeat) |
| **Application errors** | 401 UNAUTHORIZED, 400 VALIDATION_ERROR, 403 SELF_ONBOARDING_DISABLED (`SHOP_SELF_ONBOARDING_ENABLED=false`), 409 ALREADY_ONBOARDED, 409 EMAIL_UNAVAILABLE, 409 GOOGLE_IDENTITY_UNAVAILABLE, 409 PHONE_UNAVAILABLE, 409 CONFLICT (slug exhausted), 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Naturally idempotent per verified identity: unique constraints yield one shop; a retry within a 2-minute grace window returns the same shop (200). |
| **Rate limit** | 10/min per IP + per (firebase uid, IP) failure budget. |
| **Tables read** | PhoneOnboardingGrant, UserGoogleIdentity, UserPhoneIdentity, User |
| **Tables written** | Shop, ShopSettings, User, UserGoogleIdentity or UserPhoneIdentity, Session, RefreshToken, AuditLog |
| **Android** | YES (first-time Google users) |
| **Notes** | **Code vs docs:** the code (since PR #40) creates the shop with `status: ACTIVE` and `acceptsOrders: true` (QR immediately ready; no plan/subscription). `docs/MOBILE_AUTH_API.md` and `docs/API_CONTRACT.md` still describe `PILOT` + `acceptsOrders=false`; those passages are stale. The new owner has `passwordSet=false` (no password sign-in). |

### GET /api/v1/users/me/identities

Which sign-in methods are linked (masked values only).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: { password: { set: boolean }; phone: { linked: boolean; phoneMasked?: string }; google: { linked: boolean; emailMasked?: string }; googleAvailable: boolean } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead 600/min. |
| **Tables read** | User, UserPhoneIdentity, UserGoogleIdentity |
| **Tables written** | — |
| **Android** | YES (Settings) |

### POST /api/v1/users/me/identities/google

Link (or replace) a Google identity on the signed-in owner. Requires re-authentication AND a fresh Google token.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ firebaseIdToken: string; reauth: { currentPassword?: string; firebaseIdToken?: string } }`<br>`reauth` must contain EXACTLY ONE of `currentPassword` or a fresh `firebaseIdToken` of an identity already linked (for password-less accounts). |
| **Response JSON** | `{ data: { linked: true; emailMasked: string; replaced: boolean; otherSessionsEnded: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 403 INVALID_CURRENT_PASSWORD, 403 REAUTH_FAILED, 401 GOOGLE_TOKEN_INVALID, 409 GOOGLE_IDENTITY_UNAVAILABLE, 503 GOOGLE_LOGIN_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Token single-use; linking the same identity twice with a stale token → 401 GOOGLE_TOKEN_INVALID. |
| **Rate limit** | shopMutation 60/min + `acctchg` password budget. |
| **Tables read** | User, UserGoogleIdentity, UserPhoneIdentity |
| **Tables written** | UserGoogleIdentity, Session (others ended), RefreshToken (others revoked), AuditLog |
| **Android** | YES (Settings) |
| **Notes** | Ends the OTHER sessions/refresh families of the user; the current session stays. |

### POST /api/v1/users/me/identities/google/unlink

Unlink Google (refused if it is the only remaining sign-in method).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ reauth: { currentPassword?: string; firebaseIdToken?: string } }` |
| **Response JSON** | `{ data: { linked: false; otherSessionsEnded: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 NOT_FOUND, 409 LAST_SIGNIN_METHOD, 403 INVALID_CURRENT_PASSWORD, 403 REAUTH_FAILED |
| **Pagination** | — |
| **Idempotency** | Second call → 404. |
| **Rate limit** | shopMutation 60/min. |
| **Tables read** | User, UserGoogleIdentity, UserPhoneIdentity |
| **Tables written** | UserGoogleIdentity (deleted), Session, RefreshToken, AuditLog |
| **Android** | YES (Settings) |

### GET /api/v1/shop/account/phone

Linked-phone status.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: { linked: boolean; available: boolean; phoneMasked?: string; linkedAt?: string(ISO-8601); lastSignInAt?: string(ISO-8601) \| null } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | UserPhoneIdentity |
| **Tables written** | — |
| **Android** | Optional |

### POST /api/v1/shop/account/phone

Link or replace the owner's verified phone (fresh OTP token + proof of ownership).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ idToken: string; currentPassword?: string; reauthIdToken?: string }`<br>Exactly one of `currentPassword` / `reauthIdToken`. |
| **Response JSON** | `{ data: { linked: true; phoneMasked: string; replaced: boolean; otherSessionsEnded: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 403 INVALID_CURRENT_PASSWORD, 403 REAUTH_FAILED, 401 PHONE_TOKEN_INVALID, 409 PHONE_UNAVAILABLE, 503 PHONE_LOGIN_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Token single-use. |
| **Rate limit** | shopMutation 60/min. |
| **Tables read** | User, UserPhoneIdentity |
| **Tables written** | UserPhoneIdentity, Session, RefreshToken, AuditLog |
| **Android** | Optional |

### POST /api/v1/shop/account/phone/unlink

Unlink the phone (refused if it is the last sign-in method).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ currentPassword?: string; reauthIdToken?: string }` |
| **Response JSON** | `{ data: { linked: false; otherSessionsEnded: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 NOT_FOUND, 409 LAST_SIGNIN_METHOD, 403 INVALID_CURRENT_PASSWORD |
| **Pagination** | — |
| **Idempotency** | Second call → 404. |
| **Rate limit** | shopMutation 60/min. |
| **Tables read** | User, UserPhoneIdentity, UserGoogleIdentity |
| **Tables written** | UserPhoneIdentity (deleted), Session, RefreshToken, AuditLog |
| **Android** | Optional |


## 2. User profile

| Method | Path | Auth | Android |
|---|---|---|---|
| GET | `/api/v1/users/me` | Session or restricted grant | YES |
| PATCH | `/api/v1/users/me` | Any session | YES |
| GET | `/api/v1/shops/me` | Owner session | YES  |
| PATCH | `/api/v1/shops/me` | Owner session | YES |
| GET | `/api/v1/shops/me/qr` | Owner session | YES  |

### GET /api/v1/users/me

The caller's profile + shop + `nextStep`. Works for suspended shops (returns `account_blocked`) and for the restricted onboarding principal.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Session or restricted grant: A full session (owner/admin) or the restricted onboarding principal (verified Google/phone identity with no account yet). |
| **Role / scope** | any / restricted |
| **Request body** | none |
| **Response JSON** | `{ data: ProfileView }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead 600/min. |
| **Tables read** | User, UserPhoneIdentity, UserGoogleIdentity, Shop, ShopSettings, Subscription, Plan, PricingRule, AuditLog, PhoneOnboardingGrant |
| **Tables written** | — |
| **Android** | YES: call at app start / after refresh to drive navigation by `nextStep`. |

### PATCH /api/v1/users/me

Update own display name; changing email also needs the current password and ends other sessions.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Any session: Any signed-in user (owner or admin). Bearer, or cookie + `X-CSRF-Token` on non-GET. |
| **Role / scope** | any |
| **Request JSON** | `{ name?: string; email?: string; currentPassword?: string }`<br>At least one of `name`/`email`. `email` change: owner with a real password only (403 EMAIL_CHANGE_NOT_ALLOWED if `passwordSet=false`). |
| **Response JSON** | `{ data: ProfileView }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 403 INVALID_CURRENT_PASSWORD, 403 EMAIL_CHANGE_NOT_ALLOWED, 409 EMAIL_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Idempotent for the same values. |
| **Rate limit** | shopMutation. |
| **Tables read** | User |
| **Tables written** | User, Session (others ended on email change), RefreshToken, AuditLog |
| **Android** | YES |

### GET /api/v1/shops/me

The owner's shop(s): `shops` has zero or one element (single-shop data model).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: { shops: ShopProfile[]; shop: ShopProfile \| null; nextStep: string; isShopRegisteredAtLeastOne: boolean; showQr: boolean } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | User, Shop, ShopSettings, Subscription, Plan, PricingRule, AuditLog |
| **Tables written** | — |
| **Android** | YES (includes `rateInfo` = active pricing rules) |

### PATCH /api/v1/shops/me

Edit shop name, address, PIN code.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ shopName?: string; address?: string; pincode?: string }`<br>At least one field; strict body. |
| **Response JSON** | `{ data: { shops: ShopProfile[]; shop: ShopProfile \| null; nextStep: string; isShopRegisteredAtLeastOne: boolean; showQr: boolean } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Idempotent for the same values. |
| **Rate limit** | shopMutation. |
| **Tables read** | Shop |
| **Tables written** | Shop, AuditLog |
| **Android** | YES |

### GET /api/v1/shops/me/qr

QR readiness and the public URL to encode. The QR is virtual (`<WEB_ORIGIN>/p/<slug>`), never stored.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | query `shopId?` (must equal the caller's own shop, else 404) |
| **Request body** | none |
| **Response JSON** | `{ data: { ready: boolean; publicUrl: string \| null; qrCodeUrl: string \| null; reason: "shop_pending_activation" \| "shop_suspended" \| "shop_inactive" \| "invalid_slug" \| null } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 404 NOT_FOUND |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | Shop |
| **Tables written** | — |
| **Android** | YES (render QR in-app) |


## 3. Shop settings

| Method | Path | Auth | Android |
|---|---|---|---|
| GET | `/api/v1/shop/settings` | Owner session | YES |
| PUT | `/api/v1/shop/settings` | Owner session | YES |
| GET | `/api/v1/shop/hours` | Owner session | YES |
| PUT | `/api/v1/shop/hours` | Owner session | YES |
| PUT | `/api/v1/shop/hours/temporary-closure` | Owner session | YES |
| DELETE | `/api/v1/shop/hours/temporary-closure` | Owner session | YES |
| POST | `/api/v1/shop/hours/reopen` | Owner session | YES |
| DELETE | `/api/v1/shop/hours/reopen` | Owner session | YES |
| GET | `/api/v1/shop/qr` | Owner session | Prefer `GET /shops/me/qr`  |
| GET | `/api/v1/shop/devices` | Owner session | YES  |

### GET /api/v1/shop/settings

Shop name/contact/brand colour/order acceptance.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: ShopSettings }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | Shop, ShopSettings |
| **Tables written** | — |
| **Android** | YES |

### PUT /api/v1/shop/settings

Partial update (PUT with partial body): any subset of the fields, at least one.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ displayName?: string; address?: string \| null; publicContact?: string \| null; brandColor?: string \| null; acceptsOrders?: boolean }`<br>`brandColor` = `#RRGGBB`. Strict body. |
| **Response JSON** | `{ data: ShopSettings }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Idempotent (same body → same state). |
| **Rate limit** | shopMutation. |
| **Tables read** | Shop, ShopSettings |
| **Tables written** | Shop, ShopSettings, AuditLog |
| **Android** | YES |

### GET /api/v1/shop/hours

Operating hours, closures and the server-computed availability.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: { timezone: string; weeklyHours: any \| null; specialClosures: { date: string; reason: string \| null }[]; afterHoursPolicy: "ACCEPT" \| "BLOCK"; temporaryClosure: any \| null; reopenUntil: string \| null; updatedAt: string(ISO-8601) \| null; availability: any } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | ShopSettings |
| **Tables written** | — |
| **Android** | YES |
| **Notes** | `weeklyHours` = `{ mon..sun: [{ start: "HH:MM", end: "HH:MM\|24:00" }] }` (max 6 intervals/day, end < start crosses midnight). `availability.state` = open / closed / unknown. |

### PUT /api/v1/shop/hours

Update timezone / weekly hours / special closures / after-hours policy (partial).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ timezone?: string; weeklyHours?: any \| null; specialClosures?: { date: string; reason?: string \| null }[]; afterHoursPolicy?: "ACCEPT" \| "BLOCK" }`<br>`weeklyHours: null` removes the schedule; omitted = untouched. Max 366 closures. |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation. |
| **Tables read** | ShopSettings |
| **Tables written** | Shop.updatedAt (row lock), ShopSettings, AuditLog |
| **Android** | YES |

### PUT /api/v1/shop/hours/temporary-closure

Start a temporary closure (also ends any emergency reopen).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ reason?: string \| null; until?: string(ISO-8601) \| null }`<br>`until` must be in the future and within one year; null = until cleared. |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Idempotent (restarts `startedAt`). |
| **Rate limit** | shopMutation. |
| **Tables read** | ShopSettings |
| **Tables written** | ShopSettings, AuditLog |
| **Android** | YES |

### DELETE /api/v1/shop/hours/temporary-closure

Clear the temporary closure.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation. |
| **Tables read** | ShopSettings |
| **Tables written** | ShopSettings, AuditLog |
| **Android** | YES |

### POST /api/v1/shop/hours/reopen

Emergency reopen: counts as open for N minutes regardless of schedule/closures.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ minutes: number }`<br>5-1440. |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Not idempotent (resets the deadline). |
| **Rate limit** | shopMutation. |
| **Tables read** | ShopSettings |
| **Tables written** | ShopSettings.reopenUntil, AuditLog |
| **Android** | YES |

### DELETE /api/v1/shop/hours/reopen

Cancel an emergency reopen.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation. |
| **Tables read** | ShopSettings |
| **Tables written** | ShopSettings, AuditLog |
| **Android** | YES |

### GET /api/v1/shop/qr

Legacy QR payload (always returns a URL even if the shop is not live).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: { publicUrl: string; slug: string; shopName: string } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | Shop |
| **Tables written** | — |
| **Android** | Prefer `GET /shops/me/qr` (readiness-aware). |

### GET /api/v1/shop/devices

Paired devices (Windows agents / Android devices) with presence and printers.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: { devices: Device[] } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | None (all devices). |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | ShopDevice, DevicePrinter |
| **Tables written** | — |
| **Android** | YES (read-only management view) |


## 4. Shop pricing and quotes

| Method | Path | Auth | Android |
|---|---|---|---|
| GET | `/api/v1/shop/pricing-rules` | Owner session | YES |
| POST | `/api/v1/shop/pricing-rules` | Owner session | YES |
| PUT | `/api/v1/shop/pricing-rules/:id` | Owner session | YES |
| DELETE | `/api/v1/shop/pricing-rules/:id` | Owner session | YES |
| POST | `/api/v1/public/shops/:slug/quotes` | None | Customer flow only  |

### GET /api/v1/shop/pricing-rules

All pricing rules (active and inactive), ordered by colourMode, sides.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: PricingRule[] }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | None (max 4 rules: bw/colour × single/duplex). |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead 600/min. |
| **Tables read** | PricingRule |
| **Tables written** | — |
| **Android** | YES |
| **Notes** | Unique per `(shopId, paperSize, colourMode, sides)`; `paperSize` is always `"A4"`. |

### POST /api/v1/shop/pricing-rules

Create a rule.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ paperSize?: "A4"; colourMode: "bw" \| "colour"; sides: "single" \| "duplex"; pricePerSheetPaise: number; active?: boolean }`<br>`pricePerSheetPaise` 1-1,000,000 (integer paise). `active` default true. Strict. |
| **Response JSON** | `{ data: PricingRule }` |
| **HTTP status** | success 201 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 409 DUPLICATE_PRICING_RULE |
| **Pagination** | — |
| **Idempotency** | Not idempotent; a repeat → 409 DUPLICATE_PRICING_RULE (treat as "already exists", then PUT). |
| **Rate limit** | shopMutation 60/min. |
| **Tables read** | PricingRule |
| **Tables written** | PricingRule, AuditLog |
| **Android** | YES |

### PUT /api/v1/shop/pricing-rules/:id

Update a rule (partial: any of the fields, at least one).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` (rule id, 8-64 chars) |
| **Request JSON** | `{ paperSize?: "A4"; colourMode?: "bw" \| "colour"; sides?: "single" \| "duplex"; pricePerSheetPaise?: number; active?: boolean }` |
| **Response JSON** | `{ data: PricingRule }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 NOT_FOUND, 409 DUPLICATE_PRICING_RULE |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation. |
| **Tables read** | PricingRule |
| **Tables written** | PricingRule, AuditLog |
| **Android** | YES |
| **Notes** | No `If-Match`/version field: last write wins. |

### DELETE /api/v1/shop/pricing-rules/:id

Delete a rule. Existing orders keep their immutable `priceSnapshot`.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request body** | none |
| **Response JSON** | no body |
| **HTTP status** | success 204 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 NOT_FOUND |
| **Pagination** | — |
| **Idempotency** | Second call → 404. |
| **Rate limit** | shopMutation. |
| **Tables read** | PricingRule |
| **Tables written** | PricingRule (deleted), AuditLog |
| **Android** | YES |

### POST /api/v1/public/shops/:slug/quotes

Server-priced quote for an uploaded document and print options. Returns a signed `quoteId` (valid `QUOTE_TTL_SECONDS`, default 600).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Parameters** | path `slug` (`^[a-z0-9-]{3,80}$`) |
| **Request JSON** | `{ documentId: string; printOptions: PrintOptions }`<br>`copies` 1-1000; `pageSelection` `{mode:"all"}` or ≤50 `{from,to}` ranges. Strict. |
| **Response JSON** | `{ data: { quoteId: string; printOptions: PrintOptions; selectedPageCount: number; sheetsPerCopy: number; totalSheets: number; unitPricePaise: number; totalPaise: number; currency: "INR"; expiresAt: string(ISO-8601) } }` |
| **HTTP status** | success 200 |
| **Application errors** | 404 NOT_FOUND, 409 SHOP_UNAVAILABLE, 409 SHOP_CLOSED, 422 DOCUMENT_UNAVAILABLE, 422 NO_PRICING_RULE, 422 INVALID_PAGE_RANGE, 400 VALIDATION_ERROR, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe/stateless (nothing is written). Sheets = duplex ? ceil(pages/2) : pages, × copies. |
| **Rate limit** | `PUBLIC_RATE_LIMIT_MAX` 60/min per IP. |
| **Tables read** | Shop, ShopSettings, Subscription, Document, PricingRule |
| **Tables written** | — |
| **Android** | Customer flow only (not needed by the owner app) |


## 5. Shop orders and live queue

| Method | Path | Auth | Android |
|---|---|---|---|
| GET | `/api/v1/shop/orders` | Owner session | YES  |
| GET | `/api/v1/shop/orders/counts` | Owner session | YES  |
| GET | `/api/v1/shop/orders/history` | Owner session | YES |
| GET | `/api/v1/shop/orders/history/summary` | Owner session | YES |
| GET | `/api/v1/shop/orders/history/export.csv` | Owner session | Optional  |
| GET | `/api/v1/shop/orders/:id` | Owner session | YES |
| POST | `/api/v1/shop/orders/:id/transitions` | Owner session | YES |
| POST | `/api/v1/shop/orders/:id/print-now` | Owner session | YES  |
| POST | `/api/v1/shop/orders/:id/print-confirmation` | Owner session | NO |
| POST | `/api/v1/shop/orders/:id/document-access` | Owner session | YES |
| POST | `/api/v1/shop/orders/:id/document-download` | Owner session | YES |

### GET /api/v1/shop/orders

LIVE QUEUE: tenant-scoped, keyset-paginated order list with filters.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | query `status` (one or comma list of ≤8 statuses), `active` (1/true hides COLLECTED/CANCELLED/EXPIRED), `print` (pending \| initiated \| attention), `sort` (newest\|oldest, default newest), `cursor`, `limit` 1-100 (default 50). Strict: unknown keys → 400. |
| **Request body** | none |
| **Response JSON** | `{ data: OrderPage }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | Opaque keyset cursor `nextCursor` (base64url of `[createdAt, id]`). Omitted when there is no next page. |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead 600/min per session. |
| **Tables read** | Order, Document, DevicePrintJob (print=attention) |
| **Tables written** | — |
| **Android** | YES (primary list; combine with SSE / push / polling) |
| **Notes** | `print=pending` = Print not yet pressed; `initiated` = pressed; `attention` = latest print job FAILED or NEEDS_RECONCILIATION. |

### GET /api/v1/shop/orders/counts

Cheap live counters for badges.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request body** | none |
| **Response JSON** | `{ data: { pending: number; attention: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | Order, Document, DevicePrintJob |
| **Tables written** | — |
| **Android** | YES (badge / polling fallback) |

### GET /api/v1/shop/orders/history

Order history (metadata only; IST calendar-day range, search).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | query `from`/`to` (`YYYY-MM-DD`, Asia/Kolkata, inclusive; default today; max 93 days), `status`, `q` (order number or filename contains), `cursor`, `limit` 1-100 (default 25). |
| **Request body** | none |
| **Response JSON** | `{ data: { range: { from: string; to: string; timezone: string }; items: { id: string; orderNumber: string; status: string; createdAt: string(ISO-8601); originalFilename: string; pageCount: number \| null; selectedPageCount: number \| null; copies: number \| null; colourMode: string \| null; sides: string \| null; paperSize: string \| null; totalPaise: number; printInitiatedAt: string(ISO-8601) \| null; documentStatus: string; fileDeletedAt: string(ISO-8601) \| null; handledBy: string \| null }[]; nextCursor?: string } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | Opaque keyset cursor `nextCursor` (base64url of `[createdAt, id]`). Omitted when there is no next page. |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | Order, Document, OrderStatusHistory, User, ShopDevice |
| **Tables written** | — |
| **Android** | YES |

### GET /api/v1/shop/orders/history/summary

Counts for the same filters.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | query `from`, `to`, `status`, `q` (no cursor/limit). |
| **Request body** | none |
| **Response JSON** | `{ data: { timezone: string; range: { from: string; to: string }; total: number; byStatus: Record<string, number>; printInitiated: number; filesDeleted: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | Order, Document |
| **Tables written** | — |
| **Android** | YES |

### GET /api/v1/shop/orders/history/export.csv

CSV of the history filters (max 5000 rows; `x-export-truncated` header).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | query as history summary. |
| **Request body** | none |
| **Response JSON** | text/csv; charset=utf-8, `content-disposition: attachment` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | — |
| **Idempotency** | Safe (audited). |
| **Rate limit** | `RATE_LIMIT_SHOP_EXPORT_MAX` = 6/min per session. |
| **Tables read** | Order, Document |
| **Tables written** | AuditLog |
| **Android** | Optional (share/download) |

### GET /api/v1/shop/orders/:id

Order detail with document state, price snapshot and status history. Never returns storage keys or URLs.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request body** | none |
| **Response JSON** | `{ data: OrderDetail }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 404 ORDER_NOT_FOUND |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | Order, Document, OrderStatusHistory |
| **Tables written** | — |
| **Android** | YES |

### POST /api/v1/shop/orders/:id/transitions

Cancel an order. The ONLY accepted `toStatus` is `CANCELLED` (accept/ready/collected are retired; Print drives NEW→ACCEPTED→PRINTING).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request JSON** | `{ toStatus: "CANCELLED"; reason?: string; clientRequestId: string }`<br>`clientRequestId` = UUID. `reason` ≤250. |
| **Response JSON** | `{ data: { order: OrderCore } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 ORDER_NOT_FOUND, 409 INVALID_STATUS_TRANSITION |
| **Pagination** | — |
| **Idempotency** | Already CANCELLED → 200 no-op. Conditional update guards races (409 on concurrent change). |
| **Rate limit** | `RATE_LIMIT_STATUS_MAX` 120/min. |
| **Tables read** | Order, Document |
| **Tables written** | Order.status, OrderStatusHistory, AuditLog |
| **Android** | YES |

### POST /api/v1/shop/orders/:id/print-now

"Print": the one shop action. First success atomically sets `printInitiatedAt = now`, `deleteAfter = now + PRINT_RETENTION_MINUTES (30)`, moves the order NEW→ACCEPTED→PRINTING and returns a short-lived document URL.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request JSON** | `{ clientRequestId: string }` |
| **Response JSON** | `{ data: { order: { id: string; orderNumber: string; status: string }; transitioned: boolean; firstPrint: boolean; document: { status: string; printInitiatedAt: string(ISO-8601) \| null; deleteAfter: string(ISO-8601) \| null }; access: { url: string; expiresAt: string(ISO-8601); contentDisposition: "inline"; mimeType: string } } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 ORDER_NOT_FOUND, 409 INVALID_STATUS_TRANSITION, 409 DOCUMENT_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Conditional claim: only one request starts retention; repeats just re-issue access (`firstPrint: false`) and never move `printInitiatedAt`/`deleteAfter`. |
| **Rate limit** | `RATE_LIMIT_STATUS_MAX` 120/min. |
| **Tables read** | Order, Document |
| **Tables written** | Document (status → PRINTED_RETENTION, printInitiatedAt, deleteAfter), Order.status, OrderStatusHistory, AuditLog |
| **Android** | YES (open the URL in a PDF viewer / print service) |
| **Notes** | It does NOT prove paper was printed (`PRINTED` is never set by this API any more). |

### POST /api/v1/shop/orders/:id/print-confirmation

RETIRED. Always answers 410.

| | |
|---|---|
| **Status** | Deprecated (retired, returns 410) |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request body** | none |
| **Response JSON** | no body |
| **HTTP status** | success — (never succeeds) |
| **Application errors** | 410 ENDPOINT_RETIRED, 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | — |
| **Rate limit** | `RATE_LIMIT_PRINT_CONFIRM_MAX` 60/min. |
| **Tables read** | — |
| **Tables written** | — |
| **Android** | NO: do not call. |

### POST /api/v1/shop/orders/:id/document-access

Reprint / view: short-lived INLINE signed URL for the original document. Never extends retention.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request body** | none |
| **Response JSON** | `{ data: DocumentAccess }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 404 ORDER_NOT_FOUND, 410 DOCUMENT_UNAVAILABLE, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Safe to repeat; URL TTL ≤ min(300 s, time to `deleteAfter`/`expiresAt`). |
| **Rate limit** | `RATE_LIMIT_DOCUMENT_ACCESS_MAX` 60/min. |
| **Tables read** | Order, Document |
| **Tables written** | AuditLog |
| **Android** | YES |

### POST /api/v1/shop/orders/:id/document-download

Explicit "Save file": short-lived ATTACHMENT URL. Never automatic, never extends retention.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request body** | none |
| **Response JSON** | `{ data: DocumentAccess }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 404 ORDER_NOT_FOUND, 410 DOCUMENT_UNAVAILABLE, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Safe to repeat. |
| **Rate limit** | 60/min. |
| **Tables read** | Order, Document |
| **Tables written** | AuditLog |
| **Android** | YES |


## 6. Printing and devices

| Method | Path | Auth | Android |
|---|---|---|---|
| POST | `/api/v1/shop/devices/pairing-codes` | Owner session | Optional  |
| PATCH | `/api/v1/shop/devices/:id` | Owner session | Optional |
| POST | `/api/v1/shop/devices/:id/revoke` | Owner session | Optional |
| PATCH | `/api/v1/shop/devices/:id/printers/:printerId` | Owner session | Optional |
| POST | `/api/v1/shop/orders/:id/print-jobs` | Owner session | Optional  |
| GET | `/api/v1/shop/print-jobs` | Owner session | Optional |
| POST | `/api/v1/shop/print-jobs/:id/cancel` | Owner session | Optional |
| POST | `/api/v1/shop/print-jobs/:id/retry` | Owner session | Optional |
| POST | `/api/v1/shop/print-jobs/:id/reconcile` | Owner session | Optional |
| POST | `/api/v1/device/pair` | None | Only for a dedicated Android print device  |
| POST | `/api/v1/device/heartbeat` | Device credential | Device mode only |
| PUT | `/api/v1/device/push-token` | Device credential | Device mode only |
| GET | `/api/v1/device/me` | Device credential | Device mode only |
| GET | `/api/v1/device/orders` | Device credential | Device mode only |
| GET | `/api/v1/device/orders/:id` | Device credential | Device mode only |
| POST | `/api/v1/device/orders/:id/print` | Device credential | Device mode only |
| POST | `/api/v1/device/orders/:id/reprint` | Device credential | Device mode only |
| POST | `/api/v1/device/orders/:id/download` | Device credential | Device mode only |
| PUT | `/api/v1/device/printers` | Device credential | NO  |
| POST | `/api/v1/device/print-jobs/claim` | Device credential | NO  |
| GET | `/api/v1/device/print-jobs/active` | Device credential | NO  |
| POST | `/api/v1/device/print-jobs/:id/download` | Device credential | NO  |
| POST | `/api/v1/device/print-jobs/:id/progress` | Device credential | NO  |
| POST | `/api/v1/device/credential/rotate` | Device credential | Device mode only |

### POST /api/v1/shop/devices/pairing-codes

Generate a one-time pairing code `PB-XXXX-XXXX` (10 min, single use, max 5 outstanding).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{  }` |
| **Response JSON** | `{ data: { code: string; expiresAt: string(ISO-8601) } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 409 CONFLICT (too many active codes) |
| **Pagination** | — |
| **Idempotency** | Not idempotent: each call mints a new code. |
| **Rate limit** | shopMutation 60/min. |
| **Tables read** | DevicePairingCode |
| **Tables written** | DevicePairingCode, AuditLog |
| **Android** | Optional (owner shows code to a Windows agent) |

### PATCH /api/v1/shop/devices/:id

Rename a device.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request JSON** | `{ name: string }` |
| **Response JSON** | `{ data: { device: Device } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 NOT_FOUND |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation. |
| **Tables read** | ShopDevice |
| **Tables written** | ShopDevice, AuditLog |
| **Android** | Optional |

### POST /api/v1/shop/devices/:id/revoke

Revoke a device (its credential stops working immediately).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request JSON** | `{  }` |
| **Response JSON** | `{ data: { device: Device } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 NOT_FOUND |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation. |
| **Tables read** | ShopDevice |
| **Tables written** | ShopDevice (status REVOKED, pushToken cleared), AuditLog |
| **Android** | Optional |

### PATCH /api/v1/shop/devices/:id/printers/:printerId

Authorize a printer for printing and/or make it the shop default (one default per shop).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` (device), `printerId` |
| **Request JSON** | `{ authorized?: boolean; isDefault?: boolean }`<br>At least one field. Default requires authorized and present. |
| **Response JSON** | `{ data: { printer: Printer } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 NOT_FOUND, 409 PRINTER_NOT_AUTHORIZED, 409 PRINTER_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation. |
| **Tables read** | DevicePrinter, ShopDevice |
| **Tables written** | DevicePrinter, AuditLog |
| **Android** | Optional |

### POST /api/v1/shop/orders/:id/print-jobs

Queue the order for a Windows printer: starts retention via the print engine, then inserts a DevicePrintJob under a per-order lock.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` (order) |
| **Request JSON** | `{ clientRequestId: string; printerId?: string; reprint?: boolean; acknowledgeDuplicateRisk?: boolean }`<br>`clientRequestId` UUID (idempotency key, unique per shop). Default printer used when `printerId` omitted. |
| **Response JSON** | `{ data: { job: PrintJob; created: boolean } }` |
| **HTTP status** | success 201 (created) / 200 (same `clientRequestId` replayed) |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 ORDER_NOT_FOUND, 404 NOT_FOUND, 409 IDEMPOTENCY_CONFLICT, 409 ACTIVE_PRINT_JOB_EXISTS, 409 DUPLICATE_RISK_NOT_ACKNOWLEDGED, 409 PRINTER_NOT_AUTHORIZED, 409 PRINTER_UNAVAILABLE, 409 PRINTER_UNSUPPORTED_OPTIONS, 409 DOCUMENT_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | `(shopId, clientRequestId)` unique. A job already in flight → 409 ACTIVE_PRINT_JOB_EXISTS; after PRINT_INITIATED a repeat needs `reprint: true`. |
| **Rate limit** | shopMutation 60/min. |
| **Tables read** | Order, Document, DevicePrinter, ShopDevice, DevicePrintJob |
| **Tables written** | Document, Order.status, OrderStatusHistory, DevicePrintJob, AuditLog |
| **Android** | Optional (requires a Windows agent) |

### GET /api/v1/shop/print-jobs

Print jobs: in-flight plus last 24 h (max 100), or all for one order.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | query `orderId?` |
| **Request body** | none |
| **Response JSON** | `{ data: { jobs: PrintJob[] } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | None (max 100). |
| **Idempotency** | Safe (also applies lease-expiry recovery). |
| **Rate limit** | shopRead. |
| **Tables read** | DevicePrintJob, DevicePrinter |
| **Tables written** | DevicePrintJob (lease recovery), AuditLog |
| **Android** | Optional |

### POST /api/v1/shop/print-jobs/:id/cancel

Cancel a job (QUEUED → CANCELED; in flight → CANCEL_REQUESTED, the agent confirms).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request JSON** | `{  }` |
| **Response JSON** | `{ data: { job: PrintJob } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 PRINT_JOB_NOT_FOUND, 409 INVALID_STATUS_TRANSITION |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation. |
| **Tables read** | DevicePrintJob |
| **Tables written** | DevicePrintJob, AuditLog |
| **Android** | Optional |

### POST /api/v1/shop/print-jobs/:id/retry

Retry a FAILED job as a NEW job (history kept).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request JSON** | `{ clientRequestId: string; acknowledgeDuplicateRisk?: boolean }` |
| **Response JSON** | `{ data: { job: PrintJob; created: boolean } }` |
| **HTTP status** | success 201 / 200 (replay) |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 PRINT_JOB_NOT_FOUND, 409 INVALID_STATUS_TRANSITION, 409 DUPLICATE_RISK_NOT_ACKNOWLEDGED, 409 ACTIVE_PRINT_JOB_EXISTS |
| **Pagination** | — |
| **Idempotency** | Same `clientRequestId` returns the same new job. |
| **Rate limit** | shopMutation. |
| **Tables read** | DevicePrintJob, DevicePrinter |
| **Tables written** | DevicePrintJob, AuditLog |
| **Android** | Optional |

### POST /api/v1/shop/print-jobs/:id/reconcile

Human resolution of an ambiguous NEEDS_RECONCILIATION job.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request JSON** | `{ resolution: "PRINTED" \| "NOT_PRINTED_REQUEUE" \| "NOT_PRINTED_GIVE_UP"; clientRequestId?: string }`<br>`clientRequestId` is required when `resolution = NOT_PRINTED_REQUEUE`. |
| **Response JSON** | `{ data: { job: PrintJob; next: PrintJob \| null } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 PRINT_JOB_NOT_FOUND, 409 INVALID_STATUS_TRANSITION |
| **Pagination** | — |
| **Idempotency** | Only valid from NEEDS_RECONCILIATION. |
| **Rate limit** | shopMutation. |
| **Tables read** | DevicePrintJob |
| **Tables written** | DevicePrintJob, AuditLog |
| **Android** | Optional |

### POST /api/v1/device/pair

Redeem a pairing code → device record + ONE-TIME device credential.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request JSON** | `{ code: string; deviceName: string; platform: "ANDROID" \| "WINDOWS"; appVersion?: string; osVersion?: string }` |
| **Response JSON** | `{ data: { deviceId: string; deviceCredential: string; shop: { displayName: string }; heartbeatIntervalSeconds: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 400 PAIRING_CODE_INVALID, 400 VALIDATION_ERROR, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Single-use code: a lost response means generating a new code. |
| **Rate limit** | 10/min per IP (devicePair) + failure ceilings (10 per client / 10 min, 1000 global). |
| **Tables read** | DevicePairingCode, Shop, Subscription |
| **Tables written** | DevicePairingCode.usedAt, ShopDevice, AuditLog |
| **Android** | Only for a dedicated Android print device (see guide §13) |

### POST /api/v1/device/heartbeat

Presence ping (writes `lastSeenAt` at most every 30 s).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device |
| **Request JSON** | `{ appVersion?: string; osVersion?: string }` |
| **Response JSON** | `{ data: { serverTime: string(ISO-8601); heartbeatIntervalSeconds: number; device: { id: string; name: string } } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | deviceMutation 120/min per device. |
| **Tables read** | ShopDevice |
| **Tables written** | ShopDevice |
| **Android** | Device mode only |

### PUT /api/v1/device/push-token

Register the device's FCM token (device-credential push; separate from user FCM registration).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device (ANDROID) |
| **Request JSON** | `{ token: string }` |
| **Response JSON** | `{ data: { ok: true } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 409 CONFLICT (not an ANDROID device) |
| **Pagination** | — |
| **Idempotency** | Idempotent (same token = no write). |
| **Rate limit** | deviceMutation. |
| **Tables read** | ShopDevice |
| **Tables written** | ShopDevice.pushToken, AuditLog |
| **Android** | Device mode only |

### GET /api/v1/device/me

Who am I (device id, name, platform, shop name).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device |
| **Request body** | none |
| **Response JSON** | `{ data: { device: { id: string; name: string; platform: string; shopName: string } } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | deviceRead 300/min. |
| **Tables read** | ShopDevice, Shop |
| **Tables written** | — |
| **Android** | Device mode only |

### GET /api/v1/device/orders

Order list for the device's shop (same query/response as `GET /shop/orders`).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device |
| **Parameters** | query as `GET /shop/orders`. |
| **Request body** | none |
| **Response JSON** | `{ data: OrderPage }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | Opaque keyset cursor `nextCursor` (base64url of `[createdAt, id]`). Omitted when there is no next page. |
| **Idempotency** | Safe. |
| **Rate limit** | deviceRead. |
| **Tables read** | Order, Document |
| **Tables written** | — |
| **Android** | Device mode only |

### GET /api/v1/device/orders/:id

Order detail for the device's shop.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device |
| **Parameters** | path `id` |
| **Request body** | none |
| **Response JSON** | `{ data: OrderDetail }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 404 ORDER_NOT_FOUND |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | deviceRead. |
| **Tables read** | Order, Document, OrderStatusHistory |
| **Tables written** | — |
| **Android** | Device mode only |

### POST /api/v1/device/orders/:id/print

Same print engine as `print-now` (device actor).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device |
| **Parameters** | path `id` |
| **Request JSON** | `{ clientRequestId: string }` |
| **Response JSON** | `{ data: { order: { id: string; orderNumber: string; status: string }; transitioned: boolean; firstPrint: boolean; document: any; access: DocumentAccess } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 404 ORDER_NOT_FOUND, 409 INVALID_STATUS_TRANSITION, 409 DOCUMENT_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Same conditional-claim semantics as print-now. |
| **Rate limit** | deviceMutation. |
| **Tables read** | Order, Document |
| **Tables written** | Document, Order.status, OrderStatusHistory, AuditLog |
| **Android** | Device mode only |

### POST /api/v1/device/orders/:id/reprint

Reprint: inline URL; requires that Print was already initiated.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device |
| **Parameters** | path `id` |
| **Request JSON** | `{  }` |
| **Response JSON** | `{ data: DocumentAccess }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 404 ORDER_NOT_FOUND, 409 INVALID_STATUS_TRANSITION, 410 DOCUMENT_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Safe to repeat. |
| **Rate limit** | deviceMutation. |
| **Tables read** | Order, Document |
| **Tables written** | AuditLog |
| **Android** | Device mode only |

### POST /api/v1/device/orders/:id/download

Attachment URL for the order document.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device |
| **Parameters** | path `id` |
| **Request JSON** | `{  }` |
| **Response JSON** | `{ data: DocumentAccess }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 404 ORDER_NOT_FOUND, 410 DOCUMENT_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Safe to repeat. |
| **Rate limit** | deviceMutation. |
| **Tables read** | Order, Document |
| **Tables written** | AuditLog |
| **Android** | Device mode only |

### PUT /api/v1/device/printers

Windows agent reports its installed printers (replaces the device snapshot; never touches `authorized`/`isDefault`).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device (WINDOWS) |
| **Request JSON** | `{ printers: { name: string; driverName?: string; connectivity: "ONLINE" \| "OFFLINE" \| "ERROR" \| "UNKNOWN"; statusDetail?: string; supportsColour: boolean; supportsDuplex: boolean; paperSizes?: string[] }[] }`<br>≤50 printers, unique names. |
| **Response JSON** | `{ data: { printers: Printer[] } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 409 CONFLICT (not a Windows agent), 400 VALIDATION_ERROR |
| **Pagination** | — |
| **Idempotency** | Idempotent (upsert by `(deviceId, name)`). |
| **Rate limit** | deviceMutation. |
| **Tables read** | DevicePrinter |
| **Tables written** | DevicePrinter |
| **Android** | NO (Windows agent) |

### POST /api/v1/device/print-jobs/claim

Atomically lease the next QUEUED job (one in-flight job per device; an already-held job is returned again with `resumed: true`).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device (WINDOWS) |
| **Request JSON** | `{  }` |
| **Response JSON** | `{ data: { job: AgentJob \| null; resumed: boolean } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 409 CONFLICT (not a Windows agent) |
| **Pagination** | — |
| **Idempotency** | Idempotent resume of the held lease (lease 120 s). |
| **Rate limit** | deviceMutation. |
| **Tables read** | DevicePrintJob, DevicePrinter |
| **Tables written** | DevicePrintJob, AuditLog |
| **Android** | NO (Windows agent) |

### GET /api/v1/device/print-jobs/active

Non-terminal jobs of this device (restart recovery).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device (WINDOWS) |
| **Request body** | none |
| **Response JSON** | `{ data: { jobs: AgentJob[] } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 409 CONFLICT |
| **Pagination** | None (max 20). |
| **Idempotency** | Safe (applies lease-expiry recovery). |
| **Rate limit** | deviceRead. |
| **Tables read** | DevicePrintJob |
| **Tables written** | DevicePrintJob (lease recovery) |
| **Android** | NO (Windows agent) |

### POST /api/v1/device/print-jobs/:id/download

Short-lived (≤120 s) download URL for the leased job's document.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device (WINDOWS) |
| **Parameters** | path `id` |
| **Request JSON** | `{ leaseId: string }` |
| **Response JSON** | `{ data: { url: string; expiresAt: string(ISO-8601); mimeType: string; byteSize: number \| null; sha256: string \| null } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 404 PRINT_JOB_NOT_FOUND, 409 LEASE_MISMATCH, 409 INVALID_STATUS_TRANSITION, 410 DOCUMENT_UNAVAILABLE |
| **Pagination** | — |
| **Idempotency** | Safe while CLAIMED/DOWNLOADING. |
| **Rate limit** | deviceMutation. |
| **Tables read** | DevicePrintJob, Order, Document |
| **Tables written** | AuditLog |
| **Android** | NO (Windows agent) |

### POST /api/v1/device/print-jobs/:id/progress

Lease holder reports progress along explicit state edges.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device (WINDOWS) |
| **Parameters** | path `id` |
| **Request JSON** | `{ leaseId: string; status: "DOWNLOADING" \| "SUBMITTING" \| "SUBMITTED_TO_SPOOLER" \| "PRINT_INITIATED" \| "FAILED" \| "CANCELED" \| "NEEDS_RECONCILIATION"; spoolerJobId?: number; spoolerState?: string; errorCode?: string; errorMessage?: string }` |
| **Response JSON** | `{ data: { job: AgentJob } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED, 404 PRINT_JOB_NOT_FOUND, 409 LEASE_MISMATCH, 409 INVALID_STATUS_TRANSITION, 409 JOB_CANCEL_REQUESTED |
| **Pagination** | — |
| **Idempotency** | Repeating the current status is a no-op that renews the lease (replay-safe). |
| **Rate limit** | deviceMutation. |
| **Tables read** | DevicePrintJob |
| **Tables written** | DevicePrintJob, AuditLog |
| **Android** | NO (Windows agent) |

### POST /api/v1/device/credential/rotate

Rotate the device credential (old one stays valid for 600 s or until the new one is first used).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Device credential: `Authorization: Bearer pbd_<43 chars>` issued once by `POST /device/pair`. Distinct from user access tokens. |
| **Role / scope** | device |
| **Request JSON** | `{  }` |
| **Response JSON** | `{ data: { deviceCredential: string; credentialVersion: number; previousValidForSeconds: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 401 DEVICE_REVOKED, 403 SHOP_SUSPENDED, 403 SUBSCRIPTION_INACTIVE, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Each call issues a new secret; persist it before using it. |
| **Rate limit** | deviceMutation. |
| **Tables read** | ShopDevice |
| **Tables written** | ShopDevice, AuditLog |
| **Android** | Device mode only |


## 7. Notifications / FCM

| Method | Path | Auth | Android |
|---|---|---|---|
| PUT | `/api/v1/users/me/fcm-token` | Owner session | YES  |
| DELETE | `/api/v1/users/me/fcm-token` | Owner session | YES  |
| GET | `/api/v1/shop/notifications` | Owner session | YES |
| POST | `/api/v1/shop/notifications/read-all` | Owner session | YES |
| POST | `/api/v1/shop/notifications/:id/read` | Owner session | YES |
| GET | `/api/v1/shop/events` | Owner session | Optional  |

### PUT /api/v1/users/me/fcm-token

Register / refresh the FCM token of this app installation (upsert by `(user, installationId)`).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ installationId: string; token: string; platform: "android" \| "ios" \| "web" }` |
| **Response JSON** | `{ data: { registered: true; installationId: string; platform: string } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Idempotent upsert; the same token under another account revokes the older registration. |
| **Rate limit** | shopMutation. |
| **Tables read** | FcmRegistration |
| **Tables written** | FcmRegistration, AuditLog |
| **Android** | YES (call on every `onNewToken` and after login) |
| **Notes** | Token is stored AES-256-GCM encrypted and is never returned. `installationId` must equal the one used at sign-in. |

### DELETE /api/v1/users/me/fcm-token

Revoke a push registration.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{ installationId?: string; token?: string }`<br>Send EXACTLY ONE of `installationId` or `token` (a DELETE with a JSON body). |
| **Response JSON** | no body |
| **HTTP status** | success 204 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Idempotent (absent/foreign → 204, no probing). |
| **Rate limit** | shopMutation. |
| **Tables read** | FcmRegistration |
| **Tables written** | FcmRegistration (revoked), AuditLog |
| **Android** | YES (on sign-out / push opt-out) |

### GET /api/v1/shop/notifications

Durable in-app notification inbox (newest first). The recovery path for anything missed by SSE/push.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | query `limit` 1-50 (20), `cursor` (older than this `seq`), `after` (newer than this `seq`, catch-up), `unreadOnly` (true\|false\|1\|0). |
| **Request body** | none |
| **Response JSON** | `{ data: { items: NotificationDto[]; nextCursor: string \| null; hasMore: boolean; latestCursor: string \| null; unreadCount: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | Numeric `seq` cursors (decimal strings): `cursor` pages back, `after` catches up. Retention 14 days. |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | ShopNotification |
| **Tables written** | — |
| **Android** | YES |

### POST /api/v1/shop/notifications/read-all

Mark all notifications of the shop read.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Request JSON** | `{  }` |
| **Response JSON** | `{ data: { updated: number; unreadCount: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only) |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation. |
| **Tables read** | ShopNotification |
| **Tables written** | ShopNotification.readAt |
| **Android** | YES |

### POST /api/v1/shop/notifications/:id/read

Mark one notification read.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | path `id` |
| **Request JSON** | `{  }` |
| **Response JSON** | `{ data: { notification: NotificationDto; unreadCount: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 CSRF_INVALID (cookie transport only), 404 NOT_FOUND |
| **Pagination** | — |
| **Idempotency** | Idempotent. |
| **Rate limit** | shopMutation. |
| **Tables read** | ShopNotification |
| **Tables written** | ShopNotification.readAt |
| **Android** | YES |

### GET /api/v1/shop/events

Server-Sent Events stream: `order.created`, `order.statusChanged`, `order.updated`, `printJob.updated`, `document.deletionScheduled`, `notification.created`, plus `: ping` heartbeats every ≤25 s.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | header `Last-Event-ID` (optional replay from a per-shop in-memory ring buffer) |
| **Request body** | none |
| **Response JSON** | `text/event-stream` (hijacked response; no JSON envelope) |
| **HTTP status** | success 200 (stream) |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 429 RATE_LIMITED (max 10 streams per shop, 5 per session, 30 connects/min) |
| **Pagination** | — |
| **Idempotency** | Reconnect with `Last-Event-ID`; then reconcile with `GET /shop/notifications?after=` and `GET /shop/orders`. |
| **Rate limit** | sseConnect 30/min per session. |
| **Tables read** | Session, ShopNotification |
| **Tables written** | — |
| **Android** | Optional (foreground only; OkHttp SSE with Bearer header). Push (FCM) is the background path. |
| **Notes** | The event bus is in memory on a single API instance; events from the worker process never arrive. Never rely on SSE alone. |


## 8. Analytics

| Method | Path | Auth | Android |
|---|---|---|---|
| GET | `/api/v1/shop/analytics` | Owner session | YES |
| GET | `/api/v1/shop/analytics/revenue` | Owner session | Optional |
| GET | `/api/v1/shop/analytics/revenue/export.csv` | Owner session | Optional |

### GET /api/v1/shop/analytics

Dashboard figures for a range (default today IST; max 93 days).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | query `from`, `to` (ISO date-times). |
| **Request body** | none |
| **Response JSON** | `{ data: { timezone: string; range: { from: string(ISO-8601); to: string(ISO-8601) }; ordersToday: number; orderCount: number; pagesToday: number; estimatedOrderValuePaise: number; bwCount: number; colourCount: number; printsInitiated: number; newPrintRequests: number; documentsAutoDeleted: number; ordersByStatus: Record<string, number>; recentActivity: { orderId: string; orderNumber: string; fromStatus: string \| null; toStatus: string; at: string(ISO-8601) }[] } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | Order, OrderStatusHistory, Document |
| **Tables written** | — |
| **Android** | YES |
| **Notes** | Money is an ESTIMATE of quoted order value; cash is settled outside the app. |

### GET /api/v1/shop/analytics/revenue

Estimated-order-value report (totals, daily series, breakdowns, previous-range comparison).

| | |
|---|---|
| **Status** | Verified from code (inner `totals`/`daily`/`breakdown` shapes: see domain/revenue.ts; Requires confirmation before hard-typing) |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | query `from`, `to` (`YYYY-MM-DD`, IST, ≤93 days). |
| **Request body** | none |
| **Response JSON** | `{ data: { timezone: string; range: { from: string; to: string; days: number }; basis: "ESTIMATED_ORDER_VALUE"; collected: { available: false; reason: string }; totals: any; daily: any[]; breakdown: any; comparison: any } }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | shopRead. |
| **Tables read** | Order (raw grouped SQL), Document |
| **Tables written** | — |
| **Android** | Optional |

### GET /api/v1/shop/analytics/revenue/export.csv

CSV of the revenue report rows.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Owner session: Shop owner (`SHOP_OWNER` with a shop). Android: `Authorization: Bearer <accessToken>` (no CSRF). Web: `printout_session` cookie + `X-CSRF-Token` on POST/PUT/PATCH/DELETE. |
| **Role / scope** | SHOP_OWNER |
| **Parameters** | query as revenue. |
| **Request body** | none |
| **Response JSON** | text/csv; charset=utf-8 |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 SHOP_SUSPENDED, 429 RATE_LIMITED, 400 VALIDATION_ERROR |
| **Pagination** | — |
| **Idempotency** | Safe (audited). |
| **Rate limit** | 6/min per session. |
| **Tables read** | Order, Document |
| **Tables written** | AuditLog |
| **Android** | Optional |


## 9. Customer public APIs

| Method | Path | Auth | Android |
|---|---|---|---|
| GET | `/api/v1/public/shops/:slug` | None | Customer flow / deep link only |
| POST | `/api/v1/public/shops/:slug/uploads/initiate` | None | Customer flow only |
| PUT | `/api/v1/public/uploads/:uploadId/content` | Upload token | Customer flow only |
| POST | `/api/v1/public/shops/:slug/uploads/:uploadId/complete` | None | Customer flow only |
| POST | `/api/v1/public/shops/:slug/orders` | None | Customer flow only |
| GET | `/api/v1/public/orders/:token` | Tracking token (path) | YES for the customer flow |

### GET /api/v1/public/shops/:slug

Public shop page data: name, address, contact, availability, branding, print capabilities, retention window. Non-ACTIVE shops return a minimal "unavailable" object.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Parameters** | path `slug` |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 404 NOT_FOUND, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | 60/min per IP. |
| **Tables read** | Shop, ShopSettings, Subscription |
| **Tables written** | — |
| **Android** | Customer flow / deep link only |
| **Notes** | Key fields: `status, slug, displayName, address, publicContact, acceptsOrders, availability{state,orderingBlocked,serverTime,...}, retentionMinutes, branding{brandColor}, printCapabilities`. |

### POST /api/v1/public/shops/:slug/uploads/initiate

Start an upload: creates an UPLOADING Document and returns a signed one-shot content URL.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Parameters** | path `slug` |
| **Request JSON** | `{ fileName: string; byteSize: number; declaredMimeType: "application/pdf" \| "image/jpeg" \| "image/png" }` |
| **Response JSON** | `{ data: { uploadId: string; uploadUrl: string; requiredHeaders: { content-type: string }; expiresAt: string(ISO-8601); limits: { acceptedMimeTypes: string[]; maxBytes: number; maxPdfPages: number; imagePageCount: number } } }` |
| **HTTP status** | success 200 |
| **Application errors** | 404 SHOP_UNAVAILABLE, 409 SHOP_CLOSED, 422 EMPTY_FILE, 413 FILE_TOO_LARGE, 400 VALIDATION_ERROR, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Not idempotent: each call creates a Document (abandoned ones are swept after 60 min). |
| **Rate limit** | 20/min per IP (`PUBLIC_RATE_LIMIT_MAX/3`). |
| **Tables read** | Shop, ShopSettings, Subscription |
| **Tables written** | Document |
| **Android** | Customer flow only |

### PUT /api/v1/public/uploads/:uploadId/content

Stream the raw file bytes (single use; token in query).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Upload token: `token` query parameter from `uploads/initiate` (HMAC, 15 min, single use). |
| **Role / scope** | — |
| **Parameters** | path `uploadId`; query `token`; header `Content-Type` = declared MIME (or octet-stream) |
| **Request body** | Raw file bytes (not JSON). Max `UPLOAD_MAX_BYTES` (50 MiB default). |
| **Response JSON** | `{ data: { uploadId: string; byteSize: number } }` |
| **HTTP status** | success 200 |
| **Application errors** | 403 FORBIDDEN (token invalid/expired), 404 NOT_FOUND, 409 CONFLICT (already used), 413 FILE_TOO_LARGE, 415 INVALID_FILE_TYPE, 422 EMPTY_FILE, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Single use: a second PUT → 409. |
| **Rate limit** | 30/min per IP. |
| **Tables read** | Document |
| **Tables written** | Object storage (private bucket), Document.checksum / byteSize |
| **Android** | Customer flow only |

### POST /api/v1/public/shops/:slug/uploads/:uploadId/complete

Finish upload: inspects the stored file (magic bytes, PDF parse, page count) and marks the Document AVAILABLE (expires after `UNPRINTED_RETENTION_HOURS` = 24).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Parameters** | path `slug`, `uploadId` |
| **Request JSON** | `{  }` |
| **Response JSON** | `{ data: { documentId: string; detectedMimeType: string \| null; byteSize: number; pageCount: number \| null; documentStatus: string; uploadedAt: string(ISO-8601) \| null; expiresAt: string(ISO-8601) \| null } }` |
| **HTTP status** | success 200 |
| **Application errors** | 404 NOT_FOUND, 409 CONFLICT (bytes not received), 409 DOCUMENT_UNAVAILABLE, 413 FILE_TOO_LARGE, 422 INVALID_FILE_TYPE, 422 INVALID_PDF, 422 PASSWORD_PROTECTED_PDF, 422 PDF_TOO_MANY_PAGES, 422 EMPTY_FILE, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Idempotent once AVAILABLE (returns the same payload). |
| **Rate limit** | 60/min per IP. |
| **Tables read** | Document, Shop, Object storage |
| **Tables written** | Document |
| **Android** | Customer flow only |

### POST /api/v1/public/shops/:slug/orders

Create the order from a `quoteId`. The price is RE-computed from the shop's current active rules; nothing price-like is trusted from the token.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Parameters** | path `slug` |
| **Request JSON** | `{ quoteId: string; customerDisplayNameOrReference?: string; clientRequestId: string }`<br>`clientRequestId` UUID. `customerDisplayNameOrReference` ≤100. |
| **Response JSON** | `{ data: { orderNumber: string; trackingToken: string; status: string; totalPaise: number; currency: string } }` |
| **HTTP status** | success 200 |
| **Application errors** | 404 NOT_FOUND, 409 SHOP_UNAVAILABLE, 409 SHOP_CLOSED, 409 DOCUMENT_ALREADY_USED, 409 IDEMPOTENCY_CONFLICT, 422 INVALID_QUOTE, 422 QUOTE_EXPIRED, 422 DOCUMENT_UNAVAILABLE, 422 NO_PRICING_RULE, 400 VALIDATION_ERROR, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | `(shopId, clientRequestId)` unique: a retry returns the ORIGINAL order (HTTP 200, not 201). One order per Document. |
| **Rate limit** | 60/min per IP. |
| **Tables read** | Shop, ShopSettings, Subscription, Document, PricingRule, Order |
| **Tables written** | Shop.orderCounter, Order, OrderStatusHistory, ShopNotification, FCM push (best effort) |
| **Android** | Customer flow only |
| **Notes** | Same transaction writes the order, its first history row and the notification (transactional outbox). Order numbers look like `CENTRA-0001`. |

### GET /api/v1/public/orders/:token

Customer order tracking by the unguessable `trackingToken`.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Tracking token (path): The unguessable `trackingToken` in the URL is the capability. |
| **Role / scope** | — |
| **Parameters** | path `token` |
| **Request body** | none |
| **Response JSON** | `{ data: { serverTime: string(ISO-8601); retentionMinutes: number; shopSlug: string; orderNumber: string; shopName: string; pickup: { address: string \| null; contact: string \| null }; printIssue: boolean; status: string; totalPaise: number; currency: string; createdAt: string(ISO-8601); updatedAt: string(ISO-8601); printOptions: PrintOptions; selectedPageCount: number \| null; document: { fileName: string \| null; pageCount: number \| null; status: string; deleteAfter: string(ISO-8601) \| null; deletedAt: string(ISO-8601) \| null }; documentDeleteAfter: string(ISO-8601) \| null; timeline: { status: string; at: string(ISO-8601) }[] } }` |
| **HTTP status** | success 200 |
| **Application errors** | 404 NOT_FOUND (unknown and malformed tokens are indistinguishable), 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. Poll gently (≤ once per few seconds); no push exists for customers. |
| **Rate limit** | 60/min per IP. |
| **Tables read** | Order, Shop, ShopSettings, Document, OrderStatusHistory, DevicePrintJob |
| **Tables written** | — |
| **Android** | YES for the customer flow |
| **Notes** | `printIssue` = latest print job FAILED/NEEDS_RECONCILIATION. `document.fileName` is null once the file is deleted. The token is a bearer secret: never log it. |


## 10. Admin-only APIs

| Method | Path | Auth | Android |
|---|---|---|---|
| GET | `/api/v1/admin/dashboard` | Admin session | NO  |
| GET | `/api/v1/admin/orders` | Admin session | NO  |
| GET | `/api/v1/admin/shops` | Admin session | NO  |
| POST | `/api/v1/admin/shops` | Admin session | NO  |
| GET | `/api/v1/admin/shops/:id` | Admin session | NO  |
| PUT | `/api/v1/admin/shops/:id` | Admin session | NO  |
| GET | `/api/v1/admin/plans` | Admin session | NO  |
| POST | `/api/v1/admin/plans` | Admin session | NO  |
| PUT | `/api/v1/admin/plans/:id` | Admin session | NO  |
| GET | `/api/v1/admin/subscriptions` | Admin session | NO  |
| PUT | `/api/v1/admin/subscriptions/:id` | Admin session | NO  |
| GET | `/api/v1/admin/audit-logs` | Admin session | NO  |
| GET | `/api/v1/admin/account` | Admin session | NO  |
| POST | `/api/v1/admin/account/email` | Admin session | NO  |
| POST | `/api/v1/admin/account/password` | Admin session | NO  |
| GET | `/api/v1/admin/account/2fa` | Admin session | NO  |
| POST | `/api/v1/admin/account/2fa/enroll` | Admin session | NO  |
| POST | `/api/v1/admin/account/2fa/enroll/verify` | Admin session | NO  |
| POST | `/api/v1/admin/account/2fa/recovery-codes/acknowledge` | Admin session | NO  |
| POST | `/api/v1/admin/account/2fa/recovery-codes` | Admin session | NO  |
| POST | `/api/v1/admin/account/2fa/disable` | Admin session | NO  |

### GET /api/v1/admin/dashboard

Platform totals, status breakdowns, recent shops/orders.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | adminRead 600/min |
| **Tables read** | Shop, Subscription, Order, Document, Plan |
| **Tables written** | — |
| **Android** | NO (admin web only) |

### GET /api/v1/admin/orders

Cross-shop order list (operational metadata only; no filenames, tokens or URLs).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Parameters** | query `shopId`, `status`, `cursor`, `limit` 1-100 (50) |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED |
| **Pagination** | Opaque keyset cursor `nextCursor` (base64url of `[createdAt, id]`). Omitted when there is no next page. |
| **Idempotency** | Safe. |
| **Rate limit** | adminRead 600/min |
| **Tables read** | Order, Document, Shop |
| **Tables written** | — |
| **Android** | NO (admin web only) |

### GET /api/v1/admin/shops

Shop list with owner, subscription, order count.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Parameters** | query `status`, `q`, `cursor`, `limit` |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED |
| **Pagination** | Opaque keyset cursor `nextCursor` (base64url of `[createdAt, id]`). Omitted when there is no next page. |
| **Idempotency** | Safe. |
| **Rate limit** | adminRead 600/min |
| **Tables read** | Shop, Subscription, Plan, User, Order |
| **Tables written** | — |
| **Android** | NO (admin web only) |

### POST /api/v1/admin/shops

Create a shop + owner (password supplied once, Argon2id-hashed).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request JSON** | `{ slug: string; displayName: string; address?: string \| null; planId?: string; owner: { email: string; displayName: string; password: string } }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 201 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 409 CONFLICT |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | Plan |
| **Tables written** | Shop, ShopSettings, User, Subscription, AuditLog |
| **Android** | NO (admin web only) |

### GET /api/v1/admin/shops/:id

Shop detail with usage and pricing rules.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Parameters** | path `id` |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 404 NOT_FOUND |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | adminRead 600/min |
| **Tables read** | Shop, User, Subscription, Order, PricingRule |
| **Tables written** | — |
| **Android** | NO (admin web only) |

### PUT /api/v1/admin/shops/:id

Update shop (status SUSPENDED revokes all shop sessions and refresh tokens immediately).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Parameters** | path `id` |
| **Request JSON** | `{ displayName?: string; address?: string \| null; acceptsOrders?: boolean; status?: "ACTIVE" \| "SUSPENDED" \| "PILOT" \| "PAST_DUE" \| "CANCELLED" }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 404 NOT_FOUND, 409 CONFLICT |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | Shop |
| **Tables written** | Shop, Session, RefreshToken, AuditLog |
| **Android** | NO (admin web only) |

### GET /api/v1/admin/plans

Legacy billing: plans.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | adminRead 600/min |
| **Tables read** | Plan |
| **Tables written** | — |
| **Android** | NO (admin web only) |

### POST /api/v1/admin/plans

Legacy billing: create plan.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request JSON** | `{ name: string; pricePaise: number; active: boolean }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 201 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 409 CONFLICT |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | — |
| **Tables written** | Plan, AuditLog |
| **Android** | NO (admin web only) |

### PUT /api/v1/admin/plans/:id

Legacy billing: update plan.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Parameters** | path `id` |
| **Request JSON** | `{ name?: string; pricePaise?: number; active?: boolean }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 404 NOT_FOUND, 409 CONFLICT |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | Plan |
| **Tables written** | Plan, AuditLog |
| **Android** | NO (admin web only) |

### GET /api/v1/admin/subscriptions

Legacy billing: subscriptions.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Parameters** | query `status`, `cursor`, `limit` |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED |
| **Pagination** | Opaque keyset cursor `nextCursor` (base64url of `[createdAt, id]`). Omitted when there is no next page. |
| **Idempotency** | Safe. |
| **Rate limit** | adminRead 600/min |
| **Tables read** | Subscription, Plan, Shop |
| **Tables written** | — |
| **Android** | NO (admin web only) |

### PUT /api/v1/admin/subscriptions/:id

Legacy billing: create/update the subscription of shop `:id` (`:id` is the SHOP id).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Parameters** | path `id` (shop id) |
| **Request JSON** | `{ status?: "ACTIVE" \| "SUSPENDED" \| "CANCELLED"; planId?: string; renewsAt?: string(ISO-8601) \| null }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 404 NOT_FOUND, 409 CONFLICT |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | Shop, Plan, Subscription |
| **Tables written** | Subscription, AuditLog |
| **Android** | NO (admin web only) |

### GET /api/v1/admin/audit-logs

Audit log (metadata only).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Parameters** | query `shopId`, `action`, `cursor`, `limit` |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED |
| **Pagination** | Opaque keyset cursor `nextCursor` (base64url of `[createdAt, id]`). Omitted when there is no next page. |
| **Idempotency** | Safe. |
| **Rate limit** | adminRead 600/min |
| **Tables read** | AuditLog |
| **Tables written** | — |
| **Android** | NO (admin web only) |

### GET /api/v1/admin/account

Admin's own account and session info.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | adminRead 600/min |
| **Tables read** | User, Session |
| **Tables written** | — |
| **Android** | NO (admin web only) |

### POST /api/v1/admin/account/email

Change own email (current password; signs out everywhere).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request JSON** | `{ currentPassword: string; newEmail: string }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 INVALID_CURRENT_PASSWORD, 409 CONFLICT / EMAIL_UNAVAILABLE / TWO_FACTOR_ALREADY_ENABLED / NO_PENDING_ENROLLMENT / TWO_FACTOR_NOT_ENABLED |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | User |
| **Tables written** | User, Session, RefreshToken, AdminLoginChallenge, AuditLog |
| **Android** | NO (admin web only) |

### POST /api/v1/admin/account/password

Change own password (current password; signs out everywhere).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request JSON** | `{ currentPassword: string; newPassword: string }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 INVALID_CURRENT_PASSWORD, 409 CONFLICT / EMAIL_UNAVAILABLE / TWO_FACTOR_ALREADY_ENABLED / NO_PENDING_ENROLLMENT / TWO_FACTOR_NOT_ENABLED |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | User |
| **Tables written** | User, Session, RefreshToken, AdminLoginChallenge, AuditLog |
| **Android** | NO (admin web only) |

### GET /api/v1/admin/account/2fa

2FA status.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request body** | none |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | adminRead 600/min |
| **Tables read** | AdminTwoFactor, AdminRecoveryCode |
| **Tables written** | — |
| **Android** | NO (admin web only) |

### POST /api/v1/admin/account/2fa/enroll

Start TOTP enrollment (returns otpauth URI once).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request JSON** | `{ currentPassword: string }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 INVALID_CURRENT_PASSWORD, 409 CONFLICT / EMAIL_UNAVAILABLE / TWO_FACTOR_ALREADY_ENABLED / NO_PENDING_ENROLLMENT / TWO_FACTOR_NOT_ENABLED |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | User, AdminTwoFactor |
| **Tables written** | AdminTwoFactor (pending), AuditLog |
| **Android** | NO (admin web only) |

### POST /api/v1/admin/account/2fa/enroll/verify

Confirm enrollment with a code; returns recovery codes once.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request JSON** | `{ code: string }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 INVALID_CURRENT_PASSWORD, 409 CONFLICT / EMAIL_UNAVAILABLE / TWO_FACTOR_ALREADY_ENABLED / NO_PENDING_ENROLLMENT / TWO_FACTOR_NOT_ENABLED |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | AdminTwoFactor |
| **Tables written** | AdminTwoFactor, AdminRecoveryCode, User.passwordHash (rollback guard), Session, AuditLog |
| **Android** | NO (admin web only) |

### POST /api/v1/admin/account/2fa/recovery-codes/acknowledge

Acknowledge stored recovery codes (204).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request body** | none |
| **Response JSON** | no body |
| **HTTP status** | success 204 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 INVALID_CURRENT_PASSWORD, 409 CONFLICT / EMAIL_UNAVAILABLE / TWO_FACTOR_ALREADY_ENABLED / NO_PENDING_ENROLLMENT / TWO_FACTOR_NOT_ENABLED |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | AdminTwoFactor |
| **Tables written** | AdminTwoFactor.recoveryAckAt |
| **Android** | NO (admin web only) |

### POST /api/v1/admin/account/2fa/recovery-codes

Regenerate recovery codes (password + TOTP).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request JSON** | `{ currentPassword: string; code: string }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 INVALID_CURRENT_PASSWORD, 409 CONFLICT / EMAIL_UNAVAILABLE / TWO_FACTOR_ALREADY_ENABLED / NO_PENDING_ENROLLMENT / TWO_FACTOR_NOT_ENABLED |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | AdminTwoFactor, AdminRecoveryCode |
| **Tables written** | AdminRecoveryCode, AuditLog |
| **Android** | NO (admin web only) |

### POST /api/v1/admin/account/2fa/disable

Disable 2FA (password + TOTP/recovery).

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | Admin session: `PLATFORM_ADMIN` session. Cookie + `X-CSRF-Token` on non-GET (Bearer is technically accepted by the guard but admin sign-in is web-only). |
| **Role / scope** | PLATFORM_ADMIN |
| **Request JSON** | `{ currentPassword: string; method?: "totp" \| "recovery"; code: string }` |
| **Response JSON** | `{ data: any }` |
| **HTTP status** | success 200 |
| **Application errors** | 401 UNAUTHORIZED, 403 FORBIDDEN, 403 CSRF_INVALID, 429 RATE_LIMITED, 400 VALIDATION_ERROR, 403 INVALID_CURRENT_PASSWORD, 409 CONFLICT / EMAIL_UNAVAILABLE / TWO_FACTOR_ALREADY_ENABLED / NO_PENDING_ENROLLMENT / TWO_FACTOR_NOT_ENABLED |
| **Pagination** | — |
| **Idempotency** | See code (conditional updates). |
| **Rate limit** | adminMutation 60/min |
| **Tables read** | AdminTwoFactor |
| **Tables written** | AdminTwoFactor (deleted), AdminRecoveryCode (deleted), AdminLoginChallenge, Session, AuditLog |
| **Android** | NO (admin web only) |


## 11. Operations (not part of the product API)

| Method | Path | Auth | Android |
|---|---|---|---|
| GET | `/health` | None | Optional  |
| GET | `/ready` | None | NO |
| GET | `/api/v1/internal/documents/:key` | Signed URL | Indirect  |

### GET /health

Liveness (never touches the database). NOT under `/api/v1`.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request body** | none |
| **Response JSON** | `{ data: { status: "ok" } }` |
| **HTTP status** | success 200 |
| **Application errors** | — |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | — |
| **Tables read** | — |
| **Tables written** | — |
| **Android** | Optional (connectivity probe) |

### GET /ready

Readiness (`SELECT 1` within 2 s). NOT under `/api/v1`.

| | |
|---|---|
| **Status** | Verified from code |
| **Authentication** | None: Unauthenticated. Per-IP rate limit. |
| **Role / scope** | — |
| **Request body** | none |
| **Response JSON** | `{ data: { status: "ready" } }` |
| **HTTP status** | success 200 |
| **Application errors** | 503 INTERNAL_ERROR (database unavailable) |
| **Pagination** | — |
| **Idempotency** | Safe. |
| **Rate limit** | — |
| **Tables read** | PostgreSQL (SELECT 1) |
| **Tables written** | — |
| **Android** | NO |

### GET /api/v1/internal/documents/:key

Local-storage driver only: serves a stored document for a signed URL (`exp`, `sig`, `dl`). With the S3 driver, URLs point at the object store instead.

| | |
|---|---|
| **Status** | Verified from code (active only when STORAGE_DRIVER=local; production driver Requires confirmation) |
| **Authentication** | Signed URL: HMAC `exp` + `sig` query parameters issued by the API (local storage driver only). |
| **Role / scope** | — |
| **Parameters** | path `key` (object key); query `exp`, `sig`, `dl` (1 = attachment) |
| **Request body** | none |
| **Response JSON** | File bytes (PDF/JPEG/PNG), supports `Range` |
| **HTTP status** | success 200 / 206 |
| **Application errors** | 403 FORBIDDEN, 404 NOT_FOUND, 410 DOCUMENT_UNAVAILABLE, 416 |
| **Pagination** | — |
| **Idempotency** | Safe; DB row re-checked each request. |
| **Rate limit** | — |
| **Tables read** | Document, Local object storage |
| **Tables written** | — |
| **Android** | Indirect (the app opens URLs returned by print-now/document-access) |

## Not implemented (do not call)

These appear in the target-architecture spec (`docs/API_TARGET_SPEC.md`) but have **no route in the code**. They are listed so nobody integrates against them.

| Item | Status |
|---|---|
| Customer accounts / customer login / persistent customer role | **Not implemented**: customers are anonymous; the tracking token is the only handle. |
| `PrintAgent`/`Printer`/`PrintJob`/`DeletionReceipt`/`CustomerSession` APIs | **Not implemented**: the tables exist (additive schema) but no route reads or writes them. The live print path uses `ShopDevice`/`DevicePrinter`/`DevicePrintJob`. |
| Payment gateway, `Invoice`/`Payment` APIs, customer payments | **Not implemented**: platform is free; no payment processing. |
| `GET /users/:id`, multi-shop switching, staff (`Membership`) endpoints | **Not implemented** (single owner, single shop). |
| Customer push notifications / customer FCM | **Not implemented**: customers poll `GET /public/orders/:token`. |
| Phase B smart-print / printer-management additions | **Not on `main`** (the branch `feature/daksh-phase-b-smart-print-printers` has no commits beyond `main` at the time of writing). |

## Retired / deprecated endpoints

| Endpoint | Behaviour |
|---|---|
| `POST /api/v1/shop/orders/:id/print-confirmation` | Always `410 ENDPOINT_RETIRED`. Retention now starts at Print (`print-now`). |
| Order transitions Accept / Start printing / Ready / Collected via `POST /shop/orders/:id/transitions` | Rejected by validation: `toStatus` must be `CANCELLED`. Legacy `PRINTED/READY/COLLECTED` rows remain readable. |
