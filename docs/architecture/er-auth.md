# ER: authentication and identity

Models: `User`, `UserPhoneIdentity`, `UserGoogleIdentity`, `Session`, `RefreshToken`, `PhoneOnboardingGrant` (plus `Shop` for context). Admin 2FA tables are in [er-admin-security.md](./er-admin-security.md); push registrations in [er-notifications.md](./er-notifications.md).

```mermaid
erDiagram
  Shop |o--o{ User : "users (shopId nullable, SetNull)"
  User ||--o| UserPhoneIdentity : "phoneIdentity (cascade)"
  User ||--o| UserGoogleIdentity : "googleIdentity (cascade)"
  User ||--o{ Session : "sessions (cascade)"
  User |o--o{ RefreshToken : "refreshTokens (userId nullable, cascade)"

  User {
    string id PK
    string shopId FK "nullable"
    string email UK "lowercased"
    string displayName
    string passwordHash "random unusable value when passwordSet=false"
    Role role "SHOP_OWNER or PLATFORM_ADMIN"
    boolean passwordSet "false for Google/phone self-onboarded owners"
    datetime lastLoginAt "nullable, set on every session open"
  }
  UserGoogleIdentity {
    string id PK
    string userId FK "UK, one Google identity per user"
    string firebaseUid UK
    string email "Google-verified, lowercased"
    datetime lastAuthTime "replay guard"
    datetime lastSignInAt "nullable"
  }
  UserPhoneIdentity {
    string id PK
    string userId FK "UK"
    string firebaseUid UK
    string phoneE164 UK "E.164, unique across all accounts"
    datetime lastAuthTime "replay guard"
    datetime lastSignInAt "nullable"
  }
  Session {
    string id PK
    string tokenHash UK "sha256 of the opaque token"
    string userId FK
    datetime expiresAt
    datetime invalidatedAt "nullable"
    string familyId "mobile only, indexed"
    string deviceId "mobile only, installation id"
  }
  RefreshToken {
    string id PK
    string tokenHash UK "sha256"
    string familyId "indexed"
    string userId FK "null for kind=onboarding"
    string kind "user or onboarding"
    string subjectProvider "phone or google, restricted only"
    string subjectUid "firebase uid, restricted only"
    string sessionId "access Session minted with it"
    string deviceId "installation id binding"
    string clientType
    datetime expiresAt
    datetime rotatedAt "set on exchange, reuse = family revoked"
    datetime revokedAt "nullable"
    string revokedReason "nullable"
  }
  PhoneOnboardingGrant {
    string id PK
    string tokenHash UK
    string provider "phone or google"
    string firebaseUid "indexed"
    string phoneE164 "nullable"
    string email "nullable, Google-verified"
    datetime authTime
    datetime expiresAt
    string familyId "mobile only"
    string deviceId "mobile only"
  }
```

## Constraints

| Table | Unique | Foreign keys (onDelete) | Notable indexes |
|---|---|---|---|
| User | `email` | `shopId → Shop` (SetNull, nullable) | |
| UserGoogleIdentity | `userId`, `firebaseUid` | `userId → User` (Cascade) | |
| UserPhoneIdentity | `userId`, `firebaseUid`, `phoneE164` | `userId → User` (Cascade) | |
| Session | `tokenHash` | `userId → User` (Cascade) | `userId`, `familyId` |
| RefreshToken | `tokenHash` | `userId → User` (Cascade, nullable) | `familyId`, `userId`, `subjectUid`, `expiresAt` |
| PhoneOnboardingGrant | `tokenHash` | none | `familyId`, `firebaseUid`, `expiresAt` |

## How the pieces fit

- **Web session:** `Session` row (no `familyId`/`deviceId`); the cookie holds the raw token, the DB holds only `sha256(token)`. TTL `SESSION_DAYS` (7).
- **Mobile session:** the **access token is a `Session`** with `familyId` + `deviceId` and a short TTL (`ACCESS_TOKEN_TTL_MINUTES`, 15). The **refresh token is a `RefreshToken`** in the same `familyId`, single-use, rotated on every `POST /auth/refresh`. Two different secrets, both stored only as SHA-256 hashes.
- **Restricted principal** (verified Firebase Google/phone identity with no account): `PhoneOnboardingGrant` (the raw value *is* the access token on mobile) + a `RefreshToken` with `kind = 'onboarding'` and `userId = null`. It can only call `POST /shops/onboarding`, `GET /users/me` and logout. After a successful onboarding the onboarding refresh row is revoked with reason `onboarded` and the app receives a normal pair.
- **Identity resolution is by Firebase uid only:** `UserGoogleIdentity.firebaseUid` / `UserPhoneIdentity.firebaseUid`. A matching email or phone never links or signs in an account; linking is an explicit, re-authenticated owner action.
- `Shop.users` can hold several users, but the business rule is one `SHOP_OWNER` per shop (`GET /shops/me` returns the oldest owner as `ownerId`).

## Not in this diagram

The Firebase ID token, Firebase's own refresh token and the FCM token are **never stored** as such (FCM tokens are stored encrypted, see notifications). The Firebase Admin SDK verifies ID tokens server-side; nothing about a Firebase session lives in these tables except `firebaseUid`.
