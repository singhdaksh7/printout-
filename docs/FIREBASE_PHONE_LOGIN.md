# Firebase phone (SMS OTP) sign-in for shop owners

> **Status: implemented and tested with mocks and the Firebase Admin emulator mode. NOT verified against a real Firebase project or real SMS.**
> Production SMS sign-in must not be announced or relied on until the Firebase Console steps below are done and the
> [production checklist](#production-checklist) has been run end to end with a real phone. Until `FIREBASE_PROJECT_ID` is set
> the feature is off and nothing changes for anyone.

Firebase only proves "this browser controls this phone number right now". Everything else (users, roles, shops, sessions,
CSRF, audit) stays in Printout Buddy's PostgreSQL and existing session system. Email + password sign-in is unchanged and is
always available as the recovery path.

## Architecture

```
Browser (Firebase Web SDK)                     Printout API                         Firebase
 1 enter +91 number
 2 reCAPTCHA (app verification) ───────────────────────────────────────────────────▶ verify app
 3 sendVerificationCode ───────────────────────────────────────────────────────────▶ SMS to phone
 4 enter 6-digit code
 5 confirm(code) ──────────────────────────────────────────────────────────────────▶ ID token (JWT)
 6 POST /api/v1/auth/phone/session {idToken}
                                           7 firebase-admin verifyIdToken:
                                             signature, iss, aud = FIREBASE_PROJECT_ID, exp,
                                             provider = phone, phone_number, auth_time fresh
                                           8 look up linked identity (firebase uid + E.164)
                                             -> existing SHOP_OWNER user -> normal session cookie
 9 session cookie + csrfToken  ◀───────────
10 browser signs out of Firebase (nothing persisted client side)
```

Properties:

- The OTP is never seen or stored by Printout Buddy. The browser keeps no Firebase session (in-memory persistence, signed out after the exchange).
- The backend trusts only the verified token, never a phone string, user id, role or shop id from the browser. The shop is derived from the linked local user.
- A verified phone does **not** grant access by matching a phone field. Access requires an explicit link made by the signed-in owner (below).
- Only `SHOP_OWNER` users can link or use a phone. `PLATFORM_ADMIN` is refused everywhere; admin sign-in and 2FA are untouched. Device (Windows/Android agent) credentials are unrelated.
- Replay: each exchange must carry an `auth_time` newer than the last one accepted for that identity, so a captured token cannot be exchanged twice. Tokens older than `FIREBASE_AUTH_MAX_AGE_SECONDS` are refused.

### Endpoints

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/v1/auth/phone/config` | none | `enabled`, allowed calling codes. No secrets. |
| `POST /api/v1/auth/phone/session` `{idToken}` | none (rate limited, origin checked) | Exchange a verified Firebase ID token for a normal session cookie. |
| `GET /api/v1/shop/account/phone` | shop session | Link status, masked number. |
| `POST /api/v1/shop/account/phone` `{idToken, currentPassword}` | shop session + CSRF | Link or replace. Re-enter password; token must be fresh. |
| `POST /api/v1/shop/account/phone/unlink` `{currentPassword}` | shop session + CSRF | Remove the link. |

Error codes: `PHONE_TOKEN_INVALID` (401), `PHONE_NOT_LINKED` (403), `PHONE_REVERIFY_REQUIRED` (403), `PHONE_UNAVAILABLE` (409, number cannot be used), `PHONE_LOGIN_UNAVAILABLE` (503, feature off or Firebase unreachable).

## Account linking, recycling and recovery policy

- **Linking** happens only in Settings, by a signed-in owner, after re-entering the current password and verifying the new number by OTP. The token must be freshly issued. Duplicate numbers and Firebase UIDs are rejected by database uniqueness (`PHONE_UNAVAILABLE` does not reveal who holds a number).
- **Replace** is the same operation; the old number stops working immediately.
- **Unlink** needs the password. Because the password always remains, an owner can never lock themselves out by unlinking.
- **Other sessions** of the owner are ended whenever the link is added, replaced or removed; the current session continues.
- **Audit** events (no OTPs, tokens or full numbers; masked number only): link, replace, unlink, phone sign-in, refused sign-in, failed re-authentication.
- **Phone-number recycling:** carriers reassign numbers, and Firebase identifies a phone user by number, so a recycled number reaches the same Firebase UID. Mitigations: sign-in needs a link made by password re-authentication; a link idle for more than `PHONE_IDENTITY_MAX_IDLE_DAYS` (default 90) refuses sign-in with `PHONE_REVERIFY_REQUIRED` until the owner signs in with their password and re-links; owners can unlink at any time; a platform operator can remove a link directly in the database after identity checks. Tell owners to unlink before giving up a number.
- **First-time phone users** with no link get "this number is not linked" and instructions to sign in with email and link it in Settings. No shop or user is ever created and no role is granted by SMS.
- **Lost phone / lost SIM:** sign in with email + password, unlink or replace the number (this also ends other sessions). If the password is also lost, use the existing operator account-recovery procedure; SMS cannot reset a password.
- **Admin 2FA** is independent: admins cannot use phone sign-in, and `admin:2fa-reset` is unchanged.

## Firebase Console setup (not done by this change)

1. **Create or select** a Firebase project (a dedicated project per environment is recommended: staging and production).
2. **Register a Web app** (Project settings, Your apps). Copy the web config values (these are public identifiers, not secrets) into the `VITE_FIREBASE_*` build variables.
3. **Enable Phone** under Authentication, Sign-in method. Leave other providers disabled.
4. **SMS region policy** (Authentication, Settings, SMS region policy): choose *Allow* and select only the regions you serve, at minimum **India (+91)**. Anything not allowed is refused by Firebase even if the API's `PHONE_ALLOWED_CALLING_CODES` is widened. Keep the two lists identical.
5. **Authorized domains** (Authentication, Settings): `printoutbuddy.tech`, the exact staging host, and `localhost` for local development. Remove unused entries.
6. **Billing, quota and abuse limits:** phone auth beyond the free tier needs the Blaze plan. Set a Google Cloud **budget with alerts**, lower the per-project SMS quota where available, watch for SMS pumping (spikes to unusual prefixes), and keep the region policy tight.
7. **Test phone numbers** (Authentication, Sign-in method, Phone, Phone numbers for testing): add fictional numbers with fixed codes for staging QA. They send no SMS and cost nothing. Never add them to production.
8. **App Check (recommended hardening):** register the web app with reCAPTCHA Enterprise/v3 and enforce App Check for Authentication once the web client sends tokens. Not required by this change; it further limits automated SMS requests.
9. **Server identity:** give the API runtime Application Default Credentials (see below). `FIREBASE_PROJECT_ID` must equal the project in step 1.

Do not bypass reCAPTCHA in production. `appVerificationDisabledForTesting` and the mock client are test-only and never present in the production bundle (`pnpm --filter @printout/web verify:bundle` checks this).

## Configuration

### Backend (`apps/api`, also in `.env.example`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | unset | **Feature switch.** Unset = phone sign-in disabled (endpoints return `PHONE_LOGIN_UNAVAILABLE`, UI hides it). Set to the Firebase project id; tokens for any other project are refused. |
| `FIREBASE_AUTH_MAX_AGE_SECONDS` | 300 | A token's `auth_time` must be this recent (login and linking). |
| `FIREBASE_CHECK_REVOKED` | true | Also asks Firebase whether the token/user was revoked or disabled. Needs credentials; fails closed (503) if unavailable. Must be `false` only with the emulator. |
| `PHONE_ALLOWED_CALLING_CODES` | `+91` | Comma list of allowed country calling codes, enforced server side and used by the UI. |
| `PHONE_IDENTITY_MAX_IDLE_DAYS` | 90 | Recycling guard: links unused this long require re-linking. |
| `FIREBASE_AUTH_EMULATOR_HOST` | unset | **Dev/test only.** Makes firebase-admin accept unsigned tokens. The API refuses to start with it when `NODE_ENV=production`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | unset | Optional path to credentials for ADC (see below). |

### Frontend (build time, `apps/web`)

`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` (optional `VITE_FIREBASE_MESSAGING_SENDER_ID`). These are public by design; restrict the API key to the allowed web origins in Google Cloud. If they are missing, or the API reports the feature disabled, the login screen shows email + password only. `VITE_PHONE_AUTH_MOCK=1` builds the mock client (OTP `123456`); never set it for a deployed build.

### Production secrets

- Prefer **Application Default Credentials** on the host/runtime: workload identity, an attached service account, or a credentials file *outside the repository* referenced by `GOOGLE_APPLICATION_CREDENTIALS`, mounted read-only and readable only by the API user.
- The service account needs only what token verification and revocation checks require (for example *Firebase Authentication Viewer*). Verification of a normal ID token itself needs no secret, only the project id.
- **Never commit** service-account JSON, private keys or `.env` files. Gitleaks runs in CI; rotate any key that was ever exposed.
- Never log OTPs, ID tokens, cookies or credentials. The API logs none of them.

## Local development

- **Without Firebase (default):** leave `FIREBASE_PROJECT_ID` unset. Email + password only.
- **With the mock (no account needed):** API env `FIREBASE_PROJECT_ID=printout-dev`, `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`, `FIREBASE_CHECK_REVOKED=false`; web env `VITE_PHONE_AUTH_MOCK=1` plus dummy `VITE_FIREBASE_*` with `VITE_FIREBASE_PROJECT_ID=printout-dev`. OTP is `123456`. No SMS is sent.
- **With a real project:** use a staging Firebase project, real `VITE_FIREBASE_*`, ADC (`gcloud auth application-default login`), and Firebase test phone numbers rather than real SMS.

## Safe rollout and rollback

Rollout: deploy code with `FIREBASE_PROJECT_ID` unset (no behaviour change, the additive migration only adds a table) -> configure staging Firebase and run the production checklist with a test number -> set the variables in production -> link one internal owner first -> invite others.

Rollback: unset `FIREBASE_PROJECT_ID` and redeploy/restart; phone sign-in disappears and email + password carries on. Existing links are inert and harmless. The migration is additive; the table (`UserPhoneIdentity`) can stay. Only if it must be removed: `DROP TABLE "UserPhoneIdentity"` after the code that uses it is no longer deployed.

Firebase outage: the exchange returns `PHONE_LOGIN_UNAVAILABLE` or SMS does not arrive; the UI points to "Use email and password instead". Nothing else depends on Firebase at runtime. To hide the phone option during a long outage, unset `FIREBASE_PROJECT_ID`.

## Tests

| Area | Where |
| --- | --- |
| Token verification, claims, linking, replay, isolation, throttling, audit, session invalidation | `apps/api/test` (disposable PostgreSQL, fake/emulator-mode verifier) |
| Login UI states (OTP entry, paste, resend cooldown, expired/invalid code, reCAPTCHA failure, Firebase outage, rate limit) | `apps/web` unit tests (Firebase SDK mocked) |
| Link in Settings, sign in by OTP, wrong code, not linked, replace/unlink, shop A vs B, email fallback, API refusals | `e2e/13-phone-login.spec.ts` (real API with firebase-admin emulator mode, mock Firebase client) |
| Axe, overflow at 360/390/768/1440, keyboard, screenshots | `e2e/13-phone-login.spec.ts` |
| Admin login + 2FA unchanged | existing `e2e/12-admin-2fa.spec.ts`, API 2FA tests |
| Migration / drift | CI `api` job |

CI uses no real SMS and no paid Firebase traffic. **Not covered by automation:** cryptographic signature verification against Google's live certificates, real reCAPTCHA, real SMS delivery, and Firebase quotas. These need the manual production checklist.

## Production checklist

1. Console steps 1-9 done; budget alert set; region policy matches `PHONE_ALLOWED_CALLING_CODES`.
2. Staging: set variables, link an owner with a Firebase test number, sign out, sign in by OTP; confirm audit rows and that other sessions were ended.
3. Staging: a real SMS to a real phone, in India, end to end; check delivery time and reCAPTCHA on a phone browser.
4. Confirm a token from a *different* Firebase project is refused and that the API fails to start with `FIREBASE_AUTH_EMULATOR_HOST` set in production.
5. Confirm email + password and admin 2FA still work in production before and after enabling.
6. Only then enable in production and tell owners.

## Profile API and onboarding

Mobile sign-in (`POST /auth` with phone OTP, Google or email), rotating refresh tokens, the shared profile API (`/users/me`, `/shops/me`, `/shops/me/qr`), restricted shop onboarding, Google link/unlink and FCM registration are documented for client developers in [MOBILE_AUTH_API.md](MOBILE_AUTH_API.md). Web phone sign-in is unchanged.

Flags and settings (all new features are **off by default**): `SHOP_SELF_ONBOARDING_ENABLED` (a self-registered shop is `PILOT` with no plan and needs admin activation), `GOOGLE_LOGIN_ENABLED`, `FCM_PUSH_ENABLED`, `ACCESS_TOKEN_TTL_MINUTES` (15), `REFRESH_TOKEN_TTL_DAYS` (30), `REFRESH_REUSE_GRACE_SECONDS` (5), `ONBOARDING_GRANT_TTL_MINUTES` (30), `FCM_TOKEN_ENCRYPTION_KEY` (derived from `SESSION_SECRET` if unset), `FCM_STALE_DAYS` (60), `FCM_FAILURE_REVOKE_AFTER` (5). Migration `20261023100000_user_profile_onboarding` is additive. A verified phone or Google account never grants access to an existing shop; the owner-initiated, re-authenticated link flow remains the only bridge. Rollback of a feature = unset its flag; the tables can stay.
