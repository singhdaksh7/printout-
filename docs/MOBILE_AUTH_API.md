# Printout Buddy: Mobile / Web Auth and Profile API

Hand-off document for the mobile developer (Android first, iOS notes included). It describes how the app signs in (phone OTP, Google, or
email + password), how sessions and refresh tokens work, what the backend returns, how to read and change the profile and shop,
and how push (FCM) tokens are registered.

- **Everything below is implemented in the backend.** What is *not* verified against a real production Firebase project is listed in
  [Verified vs not verified](#18-verified-vs-not-verified). The "not available" fields are listed in [section 16](#16-field-availability-and-nullability).
- Web and mobile share the same identity model and the same profile data. They differ only in how credentials travel:
  web = HttpOnly cookie + `x-csrf-token`; mobile = `Authorization: Bearer` access token + rotating refresh token.
- PostgreSQL is the source of truth. Firebase proves *"this person controls this phone / Google account"*; nothing else.
- Related: [FIREBASE_PHONE_LOGIN.md](FIREBASE_PHONE_LOGIN.md) (setup, operations, web), [API_CONTRACT.md](API_CONTRACT.md), [openapi/current.yaml](openapi/current.yaml).

## 1. Base URL, envelopes

```
https://api.printoutbuddy.tech/api/v1      <- EXAMPLE HOST, TO BE CONFIRMED by the operator before release
http://10.0.2.2:3000/api/v1                <- Android emulator -> API on the developer machine
```

- Success: `{ "data": ... }`. Error: `{ "error": { "code", "message", "requestId", "details"? } }`. Switch on `code`, never on `message`. Quote `requestId` in bug reports.
- JSON only, HTTPS only in production. All auth responses carry `Cache-Control: no-store`.
- Request bodies are validated strictly where noted ("strict" = unknown keys are rejected with `400 VALIDATION_ERROR`).

## 2. IMPLEMENTED vs PLANNED

| Capability | State |
|---|---|
| `POST /auth` (otp, email, google) with access + refresh tokens | **Implemented** |
| `POST /auth/refresh` with rotation, reuse detection, grace window | **Implemented** |
| `POST /auth/logout`, `POST /auth/logout-all` | **Implemented** |
| `POST /auth/firebase/exchange` (web cookie variant, mobile flat variant) | **Implemented** |
| `GET/PATCH /users/me`, `GET/PATCH /shops/me`, `GET /shops/me/qr` | **Implemented** |
| `POST /shops/onboarding` (restricted, idempotent, **off by default**) | **Implemented** (flag `SHOP_SELF_ONBOARDING_ENABLED`) |
| `PUT/DELETE /users/me/fcm-token`, push registration at sign-in | **Implemented** |
| Push delivery to owners' devices (new order) | **Implemented, off by default** (`FCM_PUSH_ENABLED`) |
| Google sign-in + Google link/unlink | **Implemented, off by default** (`GOOGLE_LOGIN_ENABLED`) |
| Phone link/unlink with password or fresh-token re-authentication | **Implemented** |
| Multiple shops per user | **Not available.** Single-shop data model: `shops` always has 0 or 1 element. The array exists so clients need no change when multi-shop arrives. |
| Email verification flow (sending/confirming verification emails) | **Not available.** `emailVerified` is true only when a linked Google identity's Google-verified email equals the account email. |
| Payments, payment history | **Not available** (`payment` is always `null`) |
| Shop ratings, shop images, referral programme, geo location | **Not available** (`rating`, `images`, `referral`, `location` are always `null`) |
| Admin sign-in on mobile | **Not available by design.** Admins use the web console (password + 2FA). |
| Setting a password for a phone/Google-only owner | **Not available yet** (contact support) |
| iOS app | Out of scope here; the API is platform-neutral (`platform: "ios"` is accepted) |

## 3. Roles and what they can do

| `user.role` | Database role | Allowed on this API |
|---|---|---|
| `"shop"` | `SHOP_OWNER` | everything in this document |
| `"admin"` | `PLATFORM_ADMIN` | `GET /users/me`, `PATCH /users/me` (name only), `POST /auth/logout`, `POST /auth/logout-all`. **Cannot sign in on mobile** (`POST /auth` refuses; phone/Google refuse admins). Admin 2FA is untouched. |
| `null` | none | A *restricted identity* (verified phone or Google, no account yet). Only `POST /shops/onboarding`, `GET /users/me`, `POST /auth/logout`, `POST /auth/refresh`. |

There is **no customer account**. Customers upload and track orders anonymously through the public routes (unchanged).

## 4. Sessions, tokens and expiry (read this carefully)

Mobile uses **two opaque tokens**. Neither is a JWT; do not decode them. Neither is the Firebase ID token or Firebase's own refresh token.

| | Access token | Refresh token |
|---|---|---|
| Sent as | `Authorization: Bearer <accessToken>` on every API call | in the JSON body of `POST /auth/refresh` (and optionally `POST /auth/logout`). **Never** in a header, URL or cookie |
| Lifetime | `expiresIn` seconds (default **900 = 15 min**, `ACCESS_TOKEN_TTL_MINUTES`) | `refreshTokenExpiresIn` seconds (default **30 days**, `REFRESH_TOKEN_TTL_DAYS`), absolute for the family |
| Use | many | **exactly once**; each use returns a new pair (rotation) |
| CSRF header | **not needed** for bearer calls (a browser cannot send the header cross-origin) | n/a |
| Stored on the server as | hash only | SHA-256 hash only |

- `expiresIn` and `refreshTokenExpiresIn` are *seconds from now*; compute an absolute deadline from the response time, not from device-clock drift later.
- Rotation: `POST /auth/refresh` returns a **new access token and a new refresh token**; the old refresh token is dead. Always replace both.
- **Reuse detection:** presenting an already-rotated refresh token after the grace window revokes the **whole family** (the thief and the real app are both signed out). The app must then sign in again. Within `REFRESH_REUSE_GRACE_SECONDS` (default **5 s**) a repeat is treated as a client race and answers `409 REFRESH_CONFLICT` without revoking anything.
- The refresh also re-checks the account: a suspended shop gets `403 ACCOUNT_BLOCKED`.
- The server ends the **other** sessions and refresh families of an account when a sign-in method is added, replaced or removed, or the email changes. Expect `401`/`REFRESH_TOKEN_INVALID` on the other devices, then sign in again.
- `installationId` (sign-in) and `deviceId` (refresh/exchange) are the **same value**: a random id you generate once per app install (16 to 64 chars of `A-Z a-z 0-9 _ -`, e.g. a UUID without braces), stored in app storage. It binds refresh tokens and the push registration to this install. It is not a secret but do not share it between installs.

### Storage on Android

- Keep the access and refresh tokens (and `installationId`) in `EncryptedSharedPreferences` (Jetpack Security) or a DataStore file encrypted with an Android Keystore key. Never in plain `SharedPreferences`, logs, analytics, crash reports, URLs or intents.
- Disable backup of that file (`android:allowBackup="false"` or exclude it in `dataExtractionRules`/`fullBackupContent`).
- Keep the access token in memory while the app runs; persist only the refresh token and `installationId`. On logout or `REFRESH_TOKEN_INVALID`/`EXPIRED`, delete everything.
- iOS: store the same values in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), never in `UserDefaults`.

### Silent refresh loop (single-flight)

1. Before each call, if the access token expires within ~60 s, or a call returns `401 UNAUTHORIZED`, refresh.
2. Use **one** in-flight refresh at a time (a mutex / `Deferred` shared by all callers). Other callers wait for it and then retry their request with the new access token. Two parallel refreshes with the same token are what produce `409 REFRESH_CONFLICT`.
3. `200` -> persist the **new pair atomically** (write both before releasing the mutex) -> retry the original request once.
4. `409 REFRESH_CONFLICT` -> another refresh (e.g. a second process or a resumed app) is in progress: wait about 1 s, re-read storage (it may already hold the new pair), and retry once. Do not clear tokens.
5. `401 REFRESH_TOKEN_INVALID` or `401 REFRESH_TOKEN_EXPIRED` -> the family is over: clear tokens and send the user to sign-in. (After a reuse the whole family is revoked; this is the signal.)
6. `403 ACCOUNT_BLOCKED` -> clear tokens, show the blocked screen (no retry).
7. `429`/`5xx`/network error -> keep tokens, back off, retry later (honour `Retry-After`).

**App restart:** read `installationId` + refresh token from storage. If a refresh token exists, call `POST /auth/refresh` once (the in-memory access token is gone); the response already contains the full profile and `nextStep`, so route by it. If there is no token, show sign-in.

## 5. Sign in with a phone (Firebase)

Do this with the **official Firebase SDK**. Never send a phone number to our backend as proof of identity; only the Firebase ID token proves it.

1. Firebase console (owned by the operator) -> *Add app -> Android*: package name (placeholder `com.example.printoutbuddy`: use your real one) and the **debug and release SHA-1 / SHA-256** fingerprints (see [section 6](#6-sign-in-with-google-firebase), step 2). Download `google-services.json` and keep it in `app/` of **your** project. **Never commit it to a public repository and never put a service-account key in the app.**
2. Enable the *Phone* provider, set the SMS region policy (India `+91` plus anything else the operator allows; the API also enforces `PHONE_ALLOWED_CALLING_CODES`). Use Play Integrity (and the reCAPTCHA fallback) and recommend App Check to reduce SMS abuse.
3. Dependency: `com.google.firebase:firebase-auth` (BoM) + the `com.google.gms.google-services` plugin.
4. Normalise to **E.164** (`+919876543210`).
5. `PhoneAuthProvider.verifyPhoneNumber(options)`:

```kotlin
val options = PhoneAuthOptions.newBuilder(Firebase.auth)
    .setPhoneNumber("+919876543210")
    .setTimeout(60L, TimeUnit.SECONDS)
    .setActivity(activity)
    .setCallbacks(object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
        override fun onVerificationCompleted(c: PhoneAuthCredential) { signIn(c) }      // instant verification / auto-retrieval
        override fun onVerificationFailed(e: FirebaseException) { /* section 17 */ }
        override fun onCodeSent(id: String, t: PhoneAuthProvider.ForceResendingToken) { verificationId = id; resendToken = t }
    })
    .build()
PhoneAuthProvider.verifyPhoneNumber(options)
```

6. User types the 6-digit code -> `PhoneAuthProvider.getCredential(verificationId, code)` -> `Firebase.auth.signInWithCredential(credential)`.
7. Get a **fresh** ID token and send it at once. The server only accepts a token whose Firebase sign-in is at most `FIREBASE_AUTH_MAX_AGE_SECONDS` old (default **300 s**), and **a token can be used once**:

```kotlin
val idToken = Firebase.auth.currentUser!!.getIdToken(true).await().token!!
// POST /auth {loginMethod:"otp", firebaseIdToken: idToken, ...}
Firebase.auth.signOut()   // the app does not use the Firebase session after the exchange
```

8. Resend with the `ForceResendingToken`, 30 s cooldown, at most 3 resends.

Ask whether phone login is on: `GET /auth/phone/config` (public).
```json
{ "data": { "enabled": true, "allowedCallingCodes": ["+91"], "defaultCallingCode": "+91", "resendCooldownSeconds": 30 } }
```

## 6. Sign in with Google (Firebase)

Off by default (`GOOGLE_LOGIN_ENABLED=false`; the API then answers `503 GOOGLE_LOGIN_UNAVAILABLE`). Steps for the operator and the app:

1. **Firebase console -> Authentication -> Sign-in method -> Google -> Enable.** Set the *public-facing name* and *support email*, Save.
2. **Register the Android app and its fingerprints** (Project settings -> Your apps -> Add fingerprint). Add **all** of:
   - debug: `./gradlew signingReport` (or `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`) -> SHA-1 and SHA-256;
   - release/upload key: the same command for your release keystore;
   - **Play App Signing:** Play Console -> your app -> *Setup -> App signing* -> copy the *App signing key certificate* SHA-1/SHA-256 (the key Google re-signs with). Without this, Google sign-in works in debug but fails for Play Store builds.
3. **Re-download `google-services.json` AFTER adding the fingerprints** (it embeds the OAuth client entries). Put it in `app/`. **Do not commit it to a public repo.**
4. Add `com.google.android.gms:play-services-auth` (or Credential Manager `androidx.credentials` + `googleid`) and `firebase-auth`.
5. Request a Google ID token using the **Web client ID** (not the Android client ID). The Firebase plugin generates it as the string resource `default_web_client_id`.

```kotlin
val option = GetGoogleIdOption.Builder()
    .setServerClientId(getString(R.string.default_web_client_id))   // WEB client id
    .setFilterByAuthorizedAccounts(false)
    .build()
val result = credentialManager.getCredential(context, GetCredentialRequest.Builder().addCredentialOption(option).build())
val googleIdToken = GoogleIdTokenCredential.createFrom(result.credential.data).idToken
val firebaseCredential = GoogleAuthProvider.getCredential(googleIdToken, null)
Firebase.auth.signInWithCredential(firebaseCredential).await()
val firebaseIdToken = Firebase.auth.currentUser!!.getIdToken(true).await().token!!
// POST /auth {"loginMethod":"google","firebaseIdToken":"<firebaseIdToken>", ...}
Firebase.auth.signOut()
```
   (With the legacy `GoogleSignInClient`: `requestIdToken(getString(R.string.default_web_client_id))`, same `GoogleAuthProvider.getCredential`.)
6. The token sent to us is the **Firebase** ID token (provider `google.com`), never the raw Google ID token. The server requires a Google-**verified** email and a recent, single-use sign-in.

**Resolution rule (important):** the server finds the account **only** by the Firebase uid linked to it. A Google account whose email merely equals an existing owner's email **signs in to nothing and links nothing**. Accounts are never merged by email or phone.

### Account linking flows

| Starting point | What the user does | Result |
|---|---|---|
| Existing owner (email + password) | signs in, then **Settings -> Link phone**: `POST /shop/account/phone` (current password + fresh phone OTP token) | phone sign-in works afterwards |
| Existing owner | **Settings -> Link Google**: `POST /users/me/identities/google` with a fresh Google token **and** `reauth` (current password, or a fresh token of an already-linked identity) | Google sign-in works afterwards |
| Phone-only owner (self-onboarded) | links Google with `reauth.firebaseIdToken` = a fresh phone token (no password exists) | both work |
| Google-only owner | links a phone with `reauthIdToken` = a fresh Google token | both work |
| Unlinked phone or Google | signs in | **restricted identity**, `nextStep: create_shop`; nothing about any existing shop is revealed |
| Google email equals an existing account's email | signs in with Google | restricted identity; the existing owner must sign in the old way and link Google explicitly. `POST /shops/onboarding` with that email answers `409 EMAIL_UNAVAILABLE` (generic) |

Every link, replace and unlink ends the owner's **other** sessions and refresh families and is audited with masked identifiers only. The **last** sign-in method cannot be removed (`409 LAST_SIGNIN_METHOD`).

## 7. Endpoint summary

Paths are relative to the base URL. "Bearer" = `Authorization: Bearer <accessToken>`. On web, cookie + `x-csrf-token` replaces Bearer.

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /auth/phone/config` | none | phone login on? allowed calling codes |
| `POST /auth` | none (proof in body) | **mobile sign-in**: `otp`, `google` or `email` -> tokens + profile + `nextStep` |
| `POST /auth/refresh` | none (refresh token in body) | rotate the token pair |
| `POST /auth/logout` | Bearer (or refresh token in body) | end this session/family/device push |
| `POST /auth/logout-all` | Bearer | end every session and refresh family of the account |
| `POST /auth/firebase/exchange` | none (Firebase token in body) | web (cookie) and mobile (flat) variant of the OTP exchange |
| `GET /users/me` | Bearer (full or restricted) | own identity + shops + `nextStep` |
| `PATCH /users/me` | Bearer | change `name` (and `email` with the password) |
| `GET /users/me/identities` | Bearer (owner) | which sign-in methods are linked (masked) |
| `POST /users/me/identities/google` / `.../unlink` | Bearer (owner) | link / unlink Google (re-authenticated) |
| `POST /shop/account/phone`, `GET /shop/account/phone`, `POST /shop/account/phone/unlink` | Bearer (owner) | link / replace / unlink the phone (re-authenticated) |
| `GET /shops/me` | Bearer (owner) | own shop(s) |
| `PATCH /shops/me` | Bearer (owner) | `shopName`, `address`, `pincode` |
| `GET /shops/me/qr[?shopId=]` | Bearer (owner) | QR readiness and destination |
| `POST /shops/onboarding` | Bearer (**restricted** token) | register a new PILOT shop (flag, off by default) |
| `PUT /users/me/fcm-token`, `DELETE /users/me/fcm-token` | Bearer (owner) | register / revoke a push token |
| `GET /shop/orders/:id` | Bearer (owner) | order details (used after a push) |

Owner routes (`/shops/me`, `/users/me/identities*`, `/shop/*`) return `403 FORBIDDEN` to admins and to restricted tokens. There is **no** `GET /users/:id`: a caller can only ever read their own record.

## 8. `nextStep`

Server-derived; the app only reacts. Returned by `POST /auth`, `/auth/refresh`, `/auth/firebase/exchange`, `GET /users/me`, `GET /shops/me`, `POST /shops/onboarding`.

| `nextStep` | Meaning | App should |
|---|---|---|
| `dashboard` | owner with an active shop, name + address present, QR ready (admins also get `dashboard`) | open the dashboard |
| `complete_profile` | owner `name` or shop `address` is empty | profile form -> `PATCH /users/me`, `PATCH /shops/me` |
| `create_shop` | verified phone/Google with **no account/shop** | registration form -> `POST /shops/onboarding` (if `onboardingAvailable`) |
| `generate_qr` | a shop exists but is not live (e.g. self-onboarded `PILOT` awaiting admin activation) so the QR destination is not usable | QR screen from `GET /shops/me/qr`; show `reason` |
| `account_blocked` | shop suspended | blocked screen; contact support. Sign-in itself answers `403 ACCOUNT_BLOCKED` (see below) with no tokens |

Evaluation order (first match wins): admin -> `dashboard`; no shop -> `create_shop`; shop `SUSPENDED` -> `account_blocked`; missing name/address -> `complete_profile`; QR not ready -> `generate_qr`; else `dashboard`.

QR existence is **a readiness check, never a login factor**. Identity comes only from the verified Firebase token and the linked account.

```mermaid
flowchart TD
  A[Firebase OTP / Google in the app] --> B[getIdToken]
  B --> C["POST /auth (installationId, platform, fcmToken?)"]
  C -->|401 PHONE_TOKEN_INVALID / GOOGLE_TOKEN_INVALID| A
  C -->|403 ACCOUNT_BLOCKED| X[account_blocked screen]
  C -->|linked owner| D{nextStep}
  C -->|no account| E["restricted pair: user.id=null, nextStep=create_shop"]
  D --> F[complete_profile] --> D
  D --> G[generate_qr]
  D --> H[dashboard]
  E -->|onboardingAvailable| I["POST /shops/onboarding (Bearer restricted token)"]
  E -->|not available| J[Show: ask support to set up your shop]
  I --> K["full pair for the new owner, nextStep=generate_qr (PILOT, awaits admin)"]
```

```
 OTP/Google/email --> POST /auth
        |
        +-- linked owner ---------> profile + tokens --> dashboard | complete_profile | generate_qr
        +-- suspended ------------> 403 ACCOUNT_BLOCKED (no tokens)
        +-- verified, no account -> restricted tokens (user.id null) --> create_shop
                                          |  POST /shops/onboarding (flag on)
                                          v
                                    full tokens, PILOT shop --> generate_qr (admin activates later)
```

## 9. `POST /auth` (mobile sign-in)

- **Auth:** none; the proof is in the body. **Rate limit:** per IP (`LOGIN_RATE_LIMIT_MAX`/min) plus the same failure throttles as web login.
- **Request body (strict):**

| Field | Required | Rules |
|---|---|---|
| `loginMethod` | yes | `"otp"`, `"email"` or `"google"` |
| `firebaseIdToken` | for `otp`, `google` | string, 20 to 4096 chars. Fresh and single-use |
| `phoneNumber` | no (`otp` only) | E.164; if present it **must equal** the verified number (it never authorises anything) or the request fails like a bad token |
| `email`, `password` | for `email` | valid email, password 1 to 256 chars. Same throttles and argon2 check as web login; admins get `403 FORBIDDEN` |
| `fcmToken` | no | 20 to 4096 chars, no whitespace. Invalid optional values are ignored. Registered **only after** successful sign-in; a push failure never fails sign-in |
| `installationId` | yes | 16 to 64 chars `[A-Za-z0-9_-]` |
| `platform` | yes | `"android"`, `"ios"` or `"web"` |

- **Idempotency:** a Firebase token works once. Retrying the same token returns `401 PHONE_TOKEN_INVALID` / `GOOGLE_TOKEN_INVALID`; get a new token. After a lost response, sign in again with a fresh token (a successful sign-in revokes earlier families of this installation).

### 9.1 Existing owner, shop live and QR ready (`dashboard`)

```bash
curl -X POST https://api.printoutbuddy.tech/api/v1/auth -H 'content-type: application/json' -d '{
  "loginMethod": "otp",
  "firebaseIdToken": "eyJhbGciOi...",
  "installationId": "b1c2d3e4f5a6b7c8d9e0f1a2",
  "platform": "android",
  "fcmToken": "fcm-registration-token-0123456789"
}'
```
```json
{
  "data": {
    "accessToken": "v3ry-l0ng-opaque-access-token",
    "refreshToken": "0paque-refresh-token-single-use",
    "tokenType": "Bearer",
    "expiresIn": 900,
    "refreshTokenExpiresIn": 2592000,
    "isShopRegisteredAtLeastOne": true,
    "showQr": true,
    "nextStep": "dashboard",
    "onboardingAvailable": false,
    "user": {
      "id": "cm2ownerA0001", "role": "shop", "name": "Sharma Print Owner", "email": "owner@a.test",
      "phoneNumber": "+919876543210", "loginMethods": ["email", "otp"], "emailVerified": false, "phoneVerified": true,
      "createdAt": "2026-10-03T12:00:00.000Z", "updatedAt": "2026-10-23T09:00:00.000Z", "lastLoginAt": "2026-10-23T10:15:00.000Z"
    },
    "shops": [ { "...": "same object as `shop`" } ],
    "shop": {
      "id": "cm2shopA0001", "ownerId": "cm2ownerA0001", "shopName": "Sharma Print", "slug": "sharma-print",
      "phoneNumber": "+919811112222", "address": "12 MG Road, Pune", "pincode": "411001", "location": null,
      "status": "standard", "plan": { "key": "basic", "name": "Starter" },
      "isVerified": null, "isActive": true, "showQr": true, "qrCodeUrl": "https://printoutbuddy.tech/p/sharma-print",
      "rateInfo": [
        { "paperSize": "A4", "colourMode": "bw", "sides": "single", "pricePerSheetPaise": 200 },
        { "paperSize": "A4", "colourMode": "colour", "sides": "duplex", "pricePerSheetPaise": 900 }
      ],
      "services": { "colourModes": ["bw", "colour"], "sides": ["single", "duplex"] },
      "payment": null, "rating": null, "images": null, "referral": null,
      "shopStatus": "ACTIVE", "acceptsOrders": true, "isDefault": true, "registeredBy": "admin", "onboardingStatus": "dashboard",
      "createdAt": "2026-10-03T12:00:00.000Z", "updatedAt": "2026-10-20T08:00:00.000Z"
    }
  }
}
```
`showQr` and `nextStep` at the top level describe the **default shop** (`shops[0]`). `shops` and `shop` are the same shop today (single-shop model); prefer `shops` and take the element with `isDefault: true`, so the app needs no change when multiple shops arrive.

### 9.2 Existing shop, QR not ready (`generate_qr`)

Same response, but the shop is `PILOT` (or otherwise not `ACTIVE`):
```json
{ "data": { "accessToken": "...", "refreshToken": "...", "tokenType": "Bearer", "expiresIn": 900, "refreshTokenExpiresIn": 2592000,
  "isShopRegisteredAtLeastOne": true, "showQr": false, "nextStep": "generate_qr", "onboardingAvailable": false,
  "user": { "id": "cm2newowner01", "role": "shop", "name": "Anita Sharma", "email": "anita@example.com", "phoneNumber": "+919812345678",
            "loginMethods": ["otp"], "emailVerified": false, "phoneVerified": true,
            "createdAt": "2026-10-23T10:20:00.000Z", "updatedAt": "2026-10-23T10:20:00.000Z", "lastLoginAt": "2026-10-24T08:00:00.000Z" },
  "shops": [ { "id": "cm2newshop001", "ownerId": "cm2newowner01", "shopName": "Anita Xerox & Print", "slug": "anita-xerox-print-7k2a",
      "address": "Shop 4, Station Road, Pune", "pincode": "411001", "status": "standard", "plan": null, "isVerified": null, "isActive": false,
      "showQr": false, "qrCodeUrl": null, "rateInfo": [], "services": { "colourModes": [], "sides": [] },
      "shopStatus": "PILOT", "acceptsOrders": false, "isDefault": true, "registeredBy": "self", "onboardingStatus": "generate_qr",
      "phoneNumber": null, "location": null, "payment": null, "rating": null, "images": null, "referral": null,
      "createdAt": "2026-10-23T10:20:00.000Z", "updatedAt": "2026-10-23T10:20:00.000Z" } ],
  "shop": { "...": "same as shops[0]" } } }
```
(If the shop were `ACTIVE` but the owner `name` or the shop `address` were empty, `nextStep` would be `complete_profile` instead.)

### 9.3 New verified identity without a shop (restricted pair, `create_shop`)

A verified phone or Google account that is linked to nothing. You **do** get both tokens; they are scoped. `user.id` is `null`, `shops` is `[]`.
```json
{
  "data": {
    "accessToken": "restricted-access-token", "refreshToken": "restricted-refresh-token", "tokenType": "Bearer",
    "expiresIn": 900, "refreshTokenExpiresIn": 2592000,
    "isShopRegisteredAtLeastOne": false, "showQr": false, "nextStep": "create_shop", "onboardingAvailable": true,
    "user": { "id": null, "role": null, "name": null, "email": null, "phoneNumber": "+919812345678", "loginMethods": ["otp"],
              "emailVerified": false, "phoneVerified": true, "createdAt": null, "updatedAt": null, "lastLoginAt": null },
    "shops": [], "shop": null
  }
}
```
For a Google restricted identity: `"email": "<google email>"`, `"phoneNumber": null`, `"loginMethods": ["google"]`, `"emailVerified": true`, `"phoneVerified": false`.

The restricted **access token** is valid only for `POST /shops/onboarding`, `GET /users/me`, `POST /auth/logout` (all else: `403 FORBIDDEN`). Its **refresh token** keeps working through `POST /auth/refresh`; once the identity has been linked to an account (e.g. onboarding done on another device, or an owner links it), the next refresh returns the **normal** pair and profile. `onboardingAvailable` is `false` when self-registration is off: show "ask Printout Buddy support to set up your shop".

### 9.4 Blocked account

```json
HTTP/1.1 403
{ "error": { "code": "ACCOUNT_BLOCKED", "message": "This account is blocked. Contact Printout Buddy support.", "requestId": "…", "details": { "nextStep": "account_blocked" } } }
```
No tokens are issued. (`GET /users/me` with an already-issued token for a suspended shop still answers `200` with `nextStep: "account_blocked"`; other owner routes answer `403 SHOP_SUSPENDED`.)

### 9.5 Google sign-in

```bash
curl -X POST https://api.printoutbuddy.tech/api/v1/auth -H 'content-type: application/json' -d '{
  "loginMethod": "google", "firebaseIdToken": "eyJhbGciOi...", "installationId": "b1c2d3e4f5a6b7c8d9e0f1a2", "platform": "android" }'
```
Response: same shape as 9.1 (linked owner) or 9.3 (not linked; Google variant). Errors: `401 GOOGLE_TOKEN_INVALID`, `503 GOOGLE_LOGIN_UNAVAILABLE` (feature off or Firebase unavailable), `403 ACCOUNT_BLOCKED`, `403 FORBIDDEN` (admins), `429 RATE_LIMITED`.

### 9.6 Email + password (fallback)

`{"loginMethod":"email","email":"owner@a.test","password":"…","installationId":"…","platform":"android"}` -> 9.1-style response. `401 INVALID_CREDENTIALS` for wrong credentials (generic), `403 FORBIDDEN` for admins, `403 ACCOUNT_BLOCKED`, `429 RATE_LIMITED`. Owners created by phone/Google self-onboarding have **no password** and cannot use this method.

### 9.7 Other sign-in errors

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | bad body (`details` names the field) |
| 401 | `PHONE_TOKEN_INVALID` | Firebase phone token refused for **any** reason (expired, wrong project, wrong provider, replayed, too old, `phoneNumber` mismatch); one generic message |
| 401 | `GOOGLE_TOKEN_INVALID` | same for Google (also: unverified email) |
| 401 | `INVALID_CREDENTIALS` | email/password wrong |
| 403 | `PHONE_REVERIFY_REQUIRED` | phone link unused for `PHONE_IDENTITY_MAX_IDLE_DAYS` (90) or bound to a different Firebase user (recycled number): sign in another way and re-link |
| 403 | `ACCOUNT_BLOCKED` | suspended shop |
| 403 | `FORBIDDEN` | admin account, or non-owner |
| 429 | `RATE_LIMITED` | too many attempts (`Retry-After`) |
| 503 | `PHONE_LOGIN_UNAVAILABLE` / `GOOGLE_LOGIN_UNAVAILABLE` | Firebase or credentials unavailable, or feature off; offer email + password |

## 10. `POST /auth/refresh`

Unauthenticated; body only. **Rate limit:** `LOGIN_RATE_LIMIT_MAX x 3`/min per IP, and a failure budget per IP and per family.

```bash
curl -X POST https://api.printoutbuddy.tech/api/v1/auth/refresh -H 'content-type: application/json' \
  -d '{"refreshToken":"0paque-refresh-token-single-use","deviceId":"b1c2d3e4f5a6b7c8d9e0f1a2"}'
```
Body (strict): `refreshToken` 20 to 200 chars, `deviceId` = the install's `installationId`. Both required.

**Success `200`:** the full auth response of 9.1 / 9.2 / 9.3 (same flat shape, **new** `accessToken` and `refreshToken`, fresh profile and `nextStep`). A restricted pair whose identity has since been linked returns the normal pair.
```json
{ "data": { "accessToken": "new-access", "refreshToken": "new-refresh", "tokenType": "Bearer", "expiresIn": 900, "refreshTokenExpiresIn": 2591999,
  "isShopRegisteredAtLeastOne": true, "showQr": true, "nextStep": "dashboard", "onboardingAvailable": false, "user": { "...": "..." }, "shops": [ ], "shop": { } } }
```
`refreshTokenExpiresIn` counts down: the refresh family has an absolute lifetime; after `REFRESH_TOKEN_TTL_DAYS` the user signs in again.

**Reuse** (an old, already-rotated token presented after the grace window): the whole family is revoked.
```json
HTTP/1.1 401
{ "error": { "code": "REFRESH_TOKEN_INVALID", "message": "Your sign-in could not be renewed. Sign in again.", "requestId": "…" } }
```
**Race / double refresh** (same token presented again within `REFRESH_REUSE_GRACE_SECONDS`, default 5 s): nothing is revoked.
```json
HTTP/1.1 409
{ "error": { "code": "REFRESH_CONFLICT", "message": "A refresh is already in progress. Retry once the first one finishes.", "requestId": "…" } }
```
**Expired:**
```json
HTTP/1.1 401
{ "error": { "code": "REFRESH_TOKEN_EXPIRED", "message": "Your sign-in expired. Sign in again.", "requestId": "…" } }
```

| HTTP | `code` | Meaning / action |
|---|---|---|
| 200 | | new pair; replace both tokens |
| 400 | `VALIDATION_ERROR` | A missing or malformed `deviceId`. Malformed, forged, empty or over-length refresh tokens all return the same 401 `REFRESH_TOKEN_INVALID`. Edge case: a chunked body over 4096 bytes with no declared size can still receive the framework's 413. Treat any 4xx other than 409 from this endpoint as "stored token unusable": clear tokens and sign in again (do not loop) |
| 401 | `REFRESH_TOKEN_INVALID` | unknown, revoked, reused-after-grace, wrong `deviceId`, or an onboarding token already spent. Sign in again |
| 401 | `REFRESH_TOKEN_EXPIRED` | family lifetime over. Sign in again |
| 403 | `ACCOUNT_BLOCKED` / `FORBIDDEN` | suspended shop / account cannot be renewed. Stop |
| 409 | `REFRESH_CONFLICT` | concurrent refresh; wait ~1 s, re-read storage, retry once |
| 429 | `RATE_LIMITED` | back off |

## 11. Logout

```bash
curl -X POST https://api.printoutbuddy.tech/api/v1/auth/logout -H 'authorization: Bearer v3ry-l0ng-opaque-access-token'
# -> 204 No Content
```
- Ends this access session, its **whole refresh family** and **this device's push registration**. Optional body `{ "refreshToken": "…" }` also revokes that family.
- If the access token already expired, send `{ "refreshToken": "…" }` with no Authorization header: the family is revoked and the answer is `204` (an unknown or already-revoked token also answers 204). With neither a valid session nor a refresh token: `401 UNAUTHORIZED`.
- A restricted principal logs out the same way (`204`; its grant and family end).
- Web: cookie + `x-csrf-token`.

### `POST /auth/logout-all`
```bash
curl -X POST .../auth/logout-all -H 'authorization: Bearer <accessToken>' -H 'content-type: application/json' -d '{"keepPush": false}'
# -> 204
```
Ends **every** session and refresh family of the account on all devices. Push registrations are removed too unless `"keepPush": true`. Body (strict, optional): `{ "keepPush"?: boolean }`. After either logout, delete tokens locally.

## 12. Profile endpoints

All envelopes are `{data: ...}`.

### 12.1 `GET /users/me`
Auth: Bearer (full **or** restricted). Returns the profile object of the sign-in responses **without** tokens:
```json
{ "data": { "user": { "id": "cm2ownerA0001", "role": "shop", "name": "Sharma Print Owner", "email": "owner@a.test", "phoneNumber": "+919876543210",
  "loginMethods": ["email", "otp"], "emailVerified": false, "phoneVerified": true, "createdAt": "…", "updatedAt": "…", "lastLoginAt": "…" },
  "shops": [ { "id": "cm2shopA0001", "...": "…" } ], "shop": { "...": "…" }, "nextStep": "dashboard", "isShopRegisteredAtLeastOne": true, "showQr": true } }
```
A suspended shop's owner gets `200` with `"nextStep": "account_blocked"`. A restricted token gets the restricted profile of 9.3. Admin: `role: "admin"`, `shops: []`, `shop: null`, `nextStep: "dashboard"`.
Errors: `401 UNAUTHORIZED`. `firebaseUid`, push tokens, password data and other tenants are never present.

### 12.2 `PATCH /users/me`
Auth: Bearer (owner or admin). Body (strict, at least one field):
| Field | Rules |
|---|---|
| `name` | trimmed, 1 to 100 chars |
| `email` | valid, lower-cased. **Shop owners with a real password only**, and `currentPassword` is then required. Changing it ends the other sessions. Admins: `403 FORBIDDEN` (use the admin account page) |
| `currentPassword` | 1 to 256 chars; required with a changed `email` |

Response `200`: same body as `GET /users/me`. Errors: `400 VALIDATION_ERROR` (nothing to update / missing `currentPassword`), `403 INVALID_CURRENT_PASSWORD`, `403 EMAIL_CHANGE_NOT_ALLOWED` (account has no password), `409 EMAIL_UNAVAILABLE`, `429`. Role, phone, verification flags, shop and plan cannot be changed here. Idempotent: repeating the same body returns the same profile.

### 12.3 `GET /shops/me`
Auth: Bearer (owner). **Response is the shop part of the profile:** `{ "data": { "shops": [ShopProfile], "shop": ShopProfile | null, "nextStep": "…", "isShopRegisteredAtLeastOne": bool, "showQr": bool } }`. `ShopProfile` is the object in 9.1. `shops` has **0 or 1 element**; `shop` equals `shops[0]`.

### 12.4 `PATCH /shops/me`
Auth: Bearer (owner). Body (**strict**, at least one field):
| Field | Rules |
|---|---|
| `shopName` | trimmed, 2 to 100 chars. The public `slug` never changes, so printed QR posters keep working |
| `address` | trimmed, 5 to 300 chars |
| `pincode` | exactly 6 digits, first digit 1 to 9 |

Anything else (`status`, `plan`, `slug`, `acceptsOrders`, prices, `showQr`, `isVerified`, `registeredBy`...) -> `400 VALIDATION_ERROR` (strict). Prices: `/shop/pricing-rules`; hours: `/shop/hours`. Response `200`: same as `GET /shops/me`. Idempotent.

### 12.5 `GET /shops/me/qr[?shopId=<id>]`
Auth: Bearer (owner). The QR is **virtual**: its content is exactly `<WEB_ORIGIN>/p/<slug>`, derived on each call and never stored, so there is nothing to regenerate at login. `?shopId` is optional and must be the caller's own shop (anything else: generic `404 NOT_FOUND`).
```json
{ "data": { "ready": true, "publicUrl": "https://printoutbuddy.tech/p/sharma-print", "qrCodeUrl": "https://printoutbuddy.tech/p/sharma-print", "reason": null } }
```
Not ready (nothing should be printed yet, so the URL is `null`):
```json
{ "data": { "ready": false, "publicUrl": null, "qrCodeUrl": null, "reason": "shop_pending_activation" } }
```
`reason`: `shop_pending_activation` (`PILOT`), `shop_suspended`, `shop_inactive` (`PAST_DUE`/`CANCELLED`), `invalid_slug`, or `null` when ready. Render the QR **in the app** from `qrCodeUrl` (error correction Q, 4-module quiet zone). Printable posters come from the web app. The existing `GET /shop/qr` is unchanged.

## 13. Shop registration: `POST /shops/onboarding`

Registers a **new** shop for a verified identity that has no account. **Off by default** (`SHOP_SELF_ONBOARDING_ENABLED=false`): then it answers `403 SELF_ONBOARDING_DISABLED` and `onboardingAvailable` is `false` everywhere.

- **Auth:** the **restricted** token (Bearer on mobile; the grant cookie on web). A signed-in owner gets `409 ALREADY_ONBOARDED`; no token `401 UNAUTHORIZED`.
- **Body** (unknown keys are **ignored**, never trusted; role, status, plan, `isVerified`, `registeredBy`, prices, referral codes have no effect):

| Field | Required | Rules |
|---|---|---|
| `ownerName` | yes | 1 to 100 chars |
| `email` | phone principals: **yes**. Google principals: omit, or equal the verified Google email | valid email, lower-cased. Already used by another account -> `409 EMAIL_UNAVAILABLE` (generic) |
| `shopName` | yes | 2 to 100 chars |
| `address` | yes | 5 to 300 chars |
| `pincode` | yes | 6 digits, first digit 1 to 9 |
| `client` | no | `"web"` (default) or `"mobile"` |
| `deviceId` | for `client:"mobile"` | the `installationId` |

The phone number / email identity comes **only** from the verified token, never from the body.

```bash
curl -X POST https://api.printoutbuddy.tech/api/v1/shops/onboarding \
  -H 'authorization: Bearer restricted-access-token' -H 'content-type: application/json' -d '{
  "client": "mobile", "deviceId": "b1c2d3e4f5a6b7c8d9e0f1a2",
  "ownerName": "Anita Sharma", "email": "anita@example.com",
  "shopName": "Anita Xerox & Print", "address": "Shop 4, Station Road, Pune", "pincode": "411001" }'
```
**`201` first call**, `200` for an idempotent repeat. Body = the **full mobile auth response** for the new owner (the account's own pair; the restricted refresh token is spent). Example:
```json
{ "data": { "accessToken": "owner-access", "refreshToken": "owner-refresh", "tokenType": "Bearer", "expiresIn": 900, "refreshTokenExpiresIn": 2592000,
  "isShopRegisteredAtLeastOne": true, "showQr": false, "nextStep": "generate_qr", "onboardingAvailable": true,
  "user": { "id": "cm2newowner01", "role": "shop", "name": "Anita Sharma", "email": "anita@example.com", "phoneNumber": "+919812345678", "loginMethods": ["otp"], "emailVerified": false, "phoneVerified": true, "createdAt": "…", "updatedAt": "…", "lastLoginAt": "…" },
  "shops": [ { "id": "cm2newshop001", "shopName": "Anita Xerox & Print", "slug": "anita-xerox-print-7k2a", "shopStatus": "PILOT", "plan": null, "isActive": false, "showQr": false, "qrCodeUrl": null, "acceptsOrders": false, "registeredBy": "self", "onboardingStatus": "generate_qr", "...": "…" } ],
  "shop": { "...": "same as shops[0]" } } }
```
For `client:"web"` the response is the web shape (profile + `session`, `csrfToken`, `retentionMinutes`) and sets the session cookie.

- **Idempotency:** the user, shop and linked identity are created in **one transaction**; unique constraints make concurrent identical requests yield exactly one shop. A repeat (double tap, timeout retry, two devices) within the short retry window (**120 s** after success) returns the **same** shop with `200`; it never creates a second user or shop. After that window the grant has expired (`401`); sign in again.
- **Errors:** `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 SELF_ONBOARDING_DISABLED`, `409 ALREADY_ONBOARDED` (identity already has an account), `409 EMAIL_UNAVAILABLE`, `409 PHONE_UNAVAILABLE` / `GOOGLE_IDENTITY_UNAVAILABLE`, `429 RATE_LIMITED`.

### Self-registration policy decision

New verified identities do **not** automatically get a shop, ownership, a plan or any premium capability.
- Sign-in with an unlinked identity yields only the restricted pair.
- Registration is an explicit action and is **disabled by default**; the operator enables it deliberately.
- A self-registered shop is created **`PILOT`**, `acceptsOrders=false`, **no subscription and no pricing rules**. Customers cannot order from it and the QR is not ready until a **platform admin activates it** (status `ACTIVE`, plan, rates). `registeredBy` is `"self"`.
- The server alone decides role (`SHOP_OWNER`), status, plan, verification and `registeredBy`; referral codes are not honoured.
- The new owner has **no password** (`loginMethods` has no `"email"`); the verified phone or Google identity is the only sign-in until support sets credentials. Firebase being down locks them out; this is the reason the flag defaults to off.
- A verified phone or Google account **never** grants access to an existing shop. The only bridge is the owner-initiated, re-authenticated link from Settings.

## 14. Sign-in method management (owners)

All Bearer + owner. Both identities are proven for a link: the fresh token of the **new** identity and a **re-authentication** of the existing account.

### `GET /users/me/identities`
```json
{ "data": { "password": { "set": true }, "phone": { "linked": true, "phoneMasked": "+91••••••3210" },
  "google": { "linked": false }, "googleAvailable": true } }
```
Phone-only: `"password": {"set": false}`. Linked Google: `{"linked": true, "emailMasked": "a•••@example.com"}`.

### `POST /users/me/identities/google` (link or replace)
```json
{ "firebaseIdToken": "<fresh Google token>", "reauth": { "currentPassword": "…" } }
```
`reauth` must contain **exactly one** of `currentPassword` or `firebaseIdToken` (a fresh token of an already-linked identity, e.g. the phone). Response `200`: `{ "data": { "linked": true, "emailMasked": "a•••@example.com", "replaced": false, "otherSessionsEnded": 2 } }`. Errors: `403 INVALID_CURRENT_PASSWORD` (password path), `403 REAUTH_FAILED` (token path), `400 VALIDATION_ERROR`, `401 GOOGLE_TOKEN_INVALID`, `409 GOOGLE_IDENTITY_UNAVAILABLE` (that Google account already belongs to another account; the response does not say whose), `503 GOOGLE_LOGIN_UNAVAILABLE`, `429`.

### `POST /users/me/identities/google/unlink`
Body `{ "reauth": { "currentPassword": "…" } }` (or `firebaseIdToken`). `200` `{ "data": { "linked": false, "otherSessionsEnded": 1 } }`. `404 NOT_FOUND` if none linked; `409 LAST_SIGNIN_METHOD` if it is the only way to sign in.

### Phone link / unlink
- `GET /shop/account/phone` -> `{ "data": { "linked": true, "phoneMasked": "+91••••••3210", "linkedAt": "…", "lastSignInAt": "…", "available": true } }` (or `{ "linked": false, "available": true }`).
- `POST /shop/account/phone` `{ "idToken": "<fresh phone token>", "currentPassword": "…" }` **or** `{ "idToken": "…", "reauthIdToken": "<fresh token of another linked identity>" }` -> `200 { "linked": true, "phoneMasked": "…", "replaced": false, "otherSessionsEnded": 2 }`. `409 PHONE_UNAVAILABLE`, `403 INVALID_CURRENT_PASSWORD` / `REAUTH_FAILED`, `401 PHONE_TOKEN_INVALID`, `503 PHONE_LOGIN_UNAVAILABLE`.
- `POST /shop/account/phone/unlink` `{ "currentPassword": "…" }` (or `{ "reauthIdToken": "…" }`) -> `200 { "linked": false, "otherSessionsEnded": 1 }`; `409 LAST_SIGNIN_METHOD` if it is the only method.

After any of these, **other devices are signed out**; this device keeps its session.

## 15. FCM push

Tokens are sensitive device identifiers: stored encrypted (key `FCM_TOKEN_ENCRYPTION_KEY`, or derived from the server secret), **never returned by any endpoint, never logged, never in audit metadata**. A registration is always scoped to the signed-in owner and to the `installationId`. Admins get `403 FORBIDDEN`.

### Register at sign-in
Pass `fcmToken` in `POST /auth` (it is registered only **after** successful authentication; a failure never fails sign-in).

### `PUT /users/me/fcm-token` (register, refresh, rotate)
```bash
curl -X PUT https://api.printoutbuddy.tech/api/v1/users/me/fcm-token -H 'authorization: Bearer <accessToken>' -H 'content-type: application/json' \
  -d '{"installationId":"b1c2d3e4f5a6b7c8d9e0f1a2","token":"fcm-registration-token-0123456789","platform":"android"}'
```
```json
{ "data": { "registered": true, "installationId": "b1c2d3e4f5a6b7c8d9e0f1a2", "platform": "android" } }
```
Body (strict): `installationId` (as above), `token` (20 to 4096 chars, no whitespace), `platform` (`android`|`ios`|`web`). Idempotent upsert per `(owner, installationId)`. **Rotation:** call it again from `FirebaseMessagingService.onNewToken` with the new token: it **replaces** this installation's old token. If the token was registered to another account (device changed hands) it is **re-owned** by the caller, never shared. Call it on every app start too. Errors: `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN` (admin), `429`.

### `DELETE /users/me/fcm-token` (revoke)
Body (strict): **exactly one** of `{ "installationId": "…" }` or `{ "token": "…" }`. Always `204 No Content`, even if nothing matched or the token belonged to someone else (ownership cannot be probed). `POST /auth/logout` removes this device's registration automatically; `POST /auth/logout-all` removes all (unless `keepPush: true`). Remove it also when the user turns notifications off.

### Delivery (off by default: `FCM_PUSH_ENABLED=false`)
- Sent **only to the owners of the shop** that received a new order. Payload: a generic notification title plus `data: { "type": "order.new", "orderId": "<id>" }`. **No file names, customer data, URLs or tokens** go through FCM.
- Registrations not refreshed for `FCM_STALE_DAYS` (60) are skipped and swept; a token FCM reports as permanently invalid is revoked at once; after `FCM_FAILURE_REVOKE_AFTER` (5) consecutive transient failures it is revoked.
- **Background push -> details:** on receiving the data message, take `orderId`, make sure the access token is fresh (refresh if needed), then `GET /shop/orders/<orderId>` with the Bearer token. Never expect details inside the push. If the call returns `401` after a refresh or `404`, show a generic "open the app" notification.
- iOS: register the APNs key in the Firebase console, request notification permission, and use the same `PUT` with `platform: "ios"`; pushes are the same data-only payload.

## 16. Field availability and nullability

`present` = always populated. `null` = not modelled today, so always `null`; it is **never invented**. When a capability becomes real it will be added without a breaking change.

### `user`
| Field | Type | Availability |
|---|---|---|
| `id` | string \| null | `null` only for a restricted identity |
| `role` | `"shop"` \| `"admin"` \| null | `null` only for a restricted identity. Never `customer` |
| `name` | string \| null | `null` for a restricted identity |
| `email` | string \| null | `null` for a restricted **phone** identity; the Google email for a restricted Google identity |
| `phoneNumber` | E.164 \| null | the linked/just-verified phone of the caller's own account, else `null` |
| `loginMethods` | array of `"email"`,`"otp"`,`"google"` | `email` only with a real password; `otp` with a linked phone; `google` with a linked Google identity |
| `emailVerified` | boolean | `true` **only** when a linked Google identity's Google-verified email equals the account email. No email-verification flow exists |
| `phoneVerified` | boolean | `true` iff a Firebase-verified phone is linked (or the restricted identity just proved the number) |
| `createdAt`, `updatedAt`, `lastLoginAt` | ISO datetime \| null | `null` for a restricted identity; `lastLoginAt` also `null` if the user never signed in since the field was introduced |
| `isVerified`, `isActive` | **not present on `user`** | no such account-level concept; use `shop.isActive` and the `phoneVerified`/`emailVerified` flags |
| `firebaseUid` | **never exposed** | internal mapping |

### `shop` (each element of `shops`, and `shop`)
| Field | Type | Availability |
|---|---|---|
| `id`, `slug`, `shopName`, `shopStatus`, `acceptsOrders`, `isDefault`, `createdAt`, `updatedAt` | | present. `shopStatus` is `ACTIVE`/`SUSPENDED`/`PILOT`/`PAST_DUE`/`CANCELLED` |
| `ownerId` | string \| null | the shop's owner user id; `null` if there is no owner row |
| `phoneNumber` | string \| null | the shop's **public contact** number if the owner set one; **not** the login phone |
| `address` | string \| null | `null` until set |
| `pincode` | string \| null | `null` for shops created before it was collected |
| `location` | **always `null`** | no coordinates stored |
| `status` | `"standard"` \| `"premium"` | `premium` only for an **ACTIVE** subscription to the plan with key `premium`; otherwise `standard` |
| `plan` | `{ key, name }` \| null | from the subscription; `null` when none (every self-onboarded shop); `key` may be `null` for legacy plans |
| `isVerified` | **always `null`** | no admin-verification concept exists |
| `isActive` | boolean | `shopStatus === "ACTIVE"` |
| `showQr` | boolean | the QR destination is ready (live shop, well-formed slug) |
| `qrCodeUrl` | string \| null | `<origin>/p/<slug>` when ready, else `null` |
| `rateInfo` | array | active pricing rules `{paperSize, colourMode, sides, pricePerSheetPaise}`; `[]` if none |
| `services` | `{colourModes[], sides[]}` | derived from `rateInfo`; empty arrays if none |
| `payment` | **always `null`** | no payment processing or history; nothing fabricated |
| `rating` | **always `null`** | no ratings collected |
| `images` | **always `null`** | no shop images stored |
| `referral` | **always `null`** | no referral programme; no reward is ever granted |
| `registeredBy` | `"self"` \| `"admin"` \| null | derived from the creation audit record; `null` for legacy or seeded shops |
| `onboardingStatus` | the `nextStep` value | derived |

Top level: `isShopRegisteredAtLeastOne` = `shops.length > 0`; `showQr` = the default shop's `showQr` (false with no shop).

## 17. Error reference

| HTTP | `code` | Meaning | Client action |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | bad or forbidden field (`details.field`) | fix the input |
| 401 | `UNAUTHORIZED` | no, invalid or expired access token | refresh, then retry once |
| 401 | `PHONE_TOKEN_INVALID` / `GOOGLE_TOKEN_INVALID` | Firebase token refused | re-verify, send a **new** token |
| 401 | `INVALID_CREDENTIALS` | wrong email/password | ask again |
| 401 | `REFRESH_TOKEN_INVALID` / `REFRESH_TOKEN_EXPIRED` | refresh family over | clear tokens, sign in |
| 403 | `ACCOUNT_BLOCKED` | suspended shop | blocked screen |
| 403 | `SHOP_SUSPENDED` | suspended shop on an owner route | blocked screen |
| 403 | `FORBIDDEN` | wrong role / restricted token on an owner route / admin on mobile | do not retry |
| 403 | `PHONE_REVERIFY_REQUIRED` | stale or recycled phone link | sign in another way, re-link |
| 403 | `SELF_ONBOARDING_DISABLED` | registration is closed | contact support |
| 403 | `INVALID_CURRENT_PASSWORD` | password re-authentication failed | ask again |
| 403 | `REAUTH_FAILED` | token re-authentication failed | sign in again |
| 403 | `EMAIL_CHANGE_NOT_ALLOWED` | account has no password | contact support |
| 403 | `CSRF_INVALID` | web only | refresh the session |
| 404 | `NOT_FOUND` | unknown or foreign resource, nothing to unlink | |
| 409 | `REFRESH_CONFLICT` | concurrent refresh | wait ~1 s, retry once |
| 409 | `ALREADY_ONBOARDED` | caller already has an account/shop | `GET /users/me` |
| 409 | `EMAIL_UNAVAILABLE` | email cannot be used | choose another |
| 409 | `PHONE_UNAVAILABLE` / `GOOGLE_IDENTITY_UNAVAILABLE` | identity belongs to another account | contact support |
| 409 | `LAST_SIGNIN_METHOD` | would remove the only sign-in method | keep it |
| 429 | `RATE_LIMITED` | too many requests (`Retry-After`) | back off |
| 503 | `PHONE_LOGIN_UNAVAILABLE` / `GOOGLE_LOGIN_UNAVAILABLE` | feature off or Firebase unavailable | offer email + password |
| 5xx | `INTERNAL_ERROR` | bug | retry later, quote `requestId` |

Firebase **client** errors (SDK, before our API): `invalid-phone-number`, `quota-exceeded`, `too-many-requests`, `session-expired` (code expired), `invalid-verification-code`, `app-not-authorized` (SHA missing), `network-request-failed`, `captcha-check-failed`/Play Integrity failures, `account-exists-with-different-credential`. Show a generic safe message; never show raw SDK text; never log the OTP.

## 18. Verified vs not verified

| Item | Status |
|---|---|
| Backend flows with unsigned emulator-style Firebase tokens (project, expiry, replay, provider checks), rotation/reuse/grace, onboarding idempotency, linking, isolation, admin refusal | Verified by automated tests on a disposable database |
| Web UI with the mock Firebase driver | Verified by unit and Playwright tests |
| Cryptographic signature check against Google's live certificates | **Not verified** in CI |
| Real SMS delivery, Play Integrity/reCAPTCHA, quotas, India region policy | **Not verified** (needs the production Firebase project) |
| Real Google sign-in against production Firebase (OAuth client, SHA fingerprints, Play App Signing) | **Not verified** |
| Real FCM delivery to a device | **Not verified** |
| Android app against the production API | **Not verified** (developed separately) |

Do not tell users SMS, Google or push work in production until the manual checklist in [FIREBASE_PHONE_LOGIN.md](FIREBASE_PHONE_LOGIN.md#production-checklist) and a staging run with a real device are done.

## 19. Test identities and fixtures

No production credentials appear anywhere in tests or this document.
- **Firebase test phone numbers:** Firebase console -> Authentication -> Sign-in method -> Phone -> *Phone numbers for testing*, e.g. `+91 98765 00001` with code `123456`. No SMS, no cost. Debug builds only.
- **Local backend without Firebase:** run the API with `NODE_ENV=development FIREBASE_PROJECT_ID=printout-e2e FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIREBASE_CHECK_REVOKED=false` and the fake emulator `node --import tsx apps/api/test/helpers/fake-auth-emulator.ts 9099`. The real Admin SDK then accepts **unsigned** test tokens (claims, audience, issuer and expiry are checked; signatures are not). The API refuses to start with `FIREBASE_AUTH_EMULATOR_HOST` when `NODE_ENV=production`.
- **Minting test tokens** (backend repo, tests only): `mintEmulatorToken({ projectId, uid, phone, authTime })` in `apps/api/src/firebase/test-token.ts`.
- **Seed accounts:** `pnpm --filter @printout/api db:seed` (development only, password from `SEED_PASSWORD`): shop owners that can sign in with email + password via `POST /auth {loginMethod:"email"}`, then link a test phone from Settings.
- Never ship a debug build with test numbers against production.

## 20. Security boundaries

- Only a verified Firebase ID token proves a phone or Google identity. The backend checks signature, issuer, audience/project, expiry, provider, recent sign-in (default 5 min), allowed country (phone), Google-verified email, and (by default) revocation; and each token works **once**.
- A matching phone number or email **never** opens an existing shop or merges accounts.
- Admins cannot sign in on mobile, by phone or by Google; Admin 2FA is untouched.
- The tenant comes from the token; no endpoint takes a shop id or user id from the client for authorisation (`?shopId` is only an echo of the caller's own shop). There is no `GET /users/:id`.
- Refresh tokens rotate; reuse revokes the family; sign-in changes end the other sessions.
- `firebaseUid`, FCM tokens, access/refresh tokens and passwords never appear in responses beyond the token fields above, logs or audit metadata (masked phone/email only).
- SMS abuse is controlled in Firebase (quota, region policy, App Check) and by the server's failure throttles; the app must cap OTP resends.
- HTTPS only; certificate pinning optional and must allow rotation.

## 21. Production prerequisites

1. Firebase project, Android app registered with debug, release **and Play App Signing** SHA fingerprints; Phone provider (and Google provider if used) enabled; region policy; budget alerts; App Check (Play Integrity).
2. Backend env: `FIREBASE_PROJECT_ID`, Application Default Credentials (never a key file in git), `PHONE_ALLOWED_CALLING_CODES`, optional `FIREBASE_AUTH_MAX_AGE_SECONDS`, `PHONE_IDENTITY_MAX_IDLE_DAYS`.
3. Flags (all **off by default**, enable one at a time): `GOOGLE_LOGIN_ENABLED`, `SHOP_SELF_ONBOARDING_ENABLED` (only when admin activation is staffed), `FCM_PUSH_ENABLED`.
4. Token settings (defaults shown): `ACCESS_TOKEN_TTL_MINUTES=15`, `REFRESH_TOKEN_TTL_DAYS=30`, `REFRESH_REUSE_GRACE_SECONDS=5`, `ONBOARDING_GRANT_TTL_MINUTES=30`.
5. Push: `FCM_TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`; derived from `SESSION_SECRET` if unset), `FCM_STALE_DAYS=60`, `FCM_FAILURE_REVOKE_AFTER=5`; the server's Firebase credentials need the Firebase Cloud Messaging permission.
6. Apply the migrations (`prisma migrate deploy`) before the new API version starts: `20261018100000_phone_identity`, `20261023100000_user_profile_onboarding`.
7. Confirm the production API host and replace the example host in this document.
8. Staging end-to-end run on a real device (SMS, Google, push, refresh after 15 minutes, logout-all), then a staged rollout.
