# Admin two-step verification (TOTP + recovery codes)

Platform admins can protect sign-in with an authenticator-app code (RFC 6238 TOTP: SHA-1, 6 digits, 30 s) and single-use recovery codes. It is opt-in per admin. Shop owners are not affected. Admin accounts that have not enrolled sign in exactly as before.

## Architecture

| Piece | Where |
| --- | --- |
| TOTP, base32, otpauth URI | `apps/api/src/two-factor/totp.ts` (Node `crypto` only; RFC 4226/6238 vectors tested) |
| Secret encryption at rest | `two-factor/crypto.ts`: AES-256-GCM, fresh 96-bit IV, user id as AAD, `v1.<keyId>.<iv>.<ct>.<tag>` |
| Recovery codes | `two-factor/recovery.ts`: 10 codes, 10 chars from a 31-symbol alphabet, Argon2id hashes only |
| Verify/consume logic | `two-factor/service.ts` (atomic, replay-safe) |
| Sign-in challenge | `routes/auth.ts` (`POST /auth/login`, `/auth/login/2fa`, `/auth/login/2fa/cancel`) |
| Management API | `routes/admin-two-factor.ts` |
| Tables | `AdminTwoFactor`, `AdminRecoveryCode`, `AdminLoginChallenge` (migration `20261017120000_admin_two_factor`, additive) |
| Operator CLIs | `prisma/reset-admin-2fa.ts` (`admin:2fa-reset`), `prisma/rekey-2fa.ts` (`admin:2fa-rekey`) |
| UI | `apps/web/src/admin/LoginPage.tsx`, `TwoFactorSection.tsx` (Account settings) |

### Sign-in flow

1. `POST /auth/login` verifies the password (same throttling as before). If the admin has 2FA **enabled** it creates an `AdminLoginChallenge` (random token, only its SHA-256 stored, TTL 300 s) and sets the `printout_2fa` cookie (HttpOnly, path `/api/v1/auth/login/2fa`). **No session row, no session cookie, no CSRF token.** Response: `{ twoFactorRequired: true, expiresInSeconds }`.
2. `POST /auth/login/2fa { method: "totp"|"recovery", code }` reserves one attempt on the challenge (atomic, max 5), checks the code, consumes it, marks the challenge consumed (single use) and only then creates the real session (rotating any session cookie presented).
3. A pending challenge is not a session: `authenticate()` only reads the `printout_session` cookie against the `Session` table, so no privileged route can be reached. Presenting the challenge token as a session cookie is rejected (tested).
4. Each browser holds one challenge; a new password entry replaces it. Different devices/tabs have independent challenges. Changing the password or email, disabling 2FA or the operator CLI destroys pending challenges; a fingerprint of the password hash also voids a challenge if the password changes underneath it.

### Replay, brute force

* A code is accepted only for a time-step strictly greater than `lastUsedStep`, advanced with a conditional `UPDATE`; of any number of concurrent requests with the same code exactly one succeeds. Skew window: +-1 step (30 s).
* Per challenge: 5 wrong attempts then dead (parallel guesses cannot overshoot). Per admin: `2 x LOGIN_FAIL_MAX` wrong codes per `LOGIN_FAIL_WINDOW_MINUTES` then `429` (in-memory, per API process, like the existing login throttle; run one API instance). Per IP: the login route limiter.
* Recovery codes: ~49.5 bits, Argon2id at rest, consumed with a conditional `UPDATE`.

### Session and credential effects

| Event | Other sessions | Current session | Pending challenges | 2FA |
| --- | --- | --- | --- | --- |
| Enable 2FA | ended | kept | n/a | on |
| Disable 2FA | ended | kept | destroyed | off |
| Regenerate recovery codes | kept | kept | kept | on |
| Change password / email | ended | ended | destroyed | stays on |
| `admin:update` CLI | ended | n/a | destroyed | stays on |
| `admin:2fa-reset` CLI | ended | n/a | destroyed | removed |
| Recovery code used to sign in | kept | new session | consumed | on |

Existing sessions created before an admin enrolls are ended at enrollment (other than the one enrolling). Existing admin sessions are otherwise unaffected by deploying this feature.

## Configuration

| Variable | Meaning |
| --- | --- |
| `TWO_FACTOR_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Separate from every other secret (production refuses a reused value). **Unset = enrollment unavailable**; an admin who is already enrolled cannot sign in while it is unset (fail closed, never a bypass). |
| `TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS` | Comma list of retired keys, only during rotation. |
| `TWO_FACTOR_CHALLENGE_TTL_SECONDS` | default 300 (60-900). |
| `TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS` | default 5 (1-10). |

Never print, log, commit or email the key, TOTP secrets, recovery codes or session tokens. Request logs redact `code`, `secret`, `manualKey`, `otpauthUri`, `recoveryCodes`; audit metadata carries only method/reason/counts.

## Safe deployment order

1. Generate the key and store it in the secret manager (also back it up: losing it makes enrolled secrets unrecoverable; the recovery is the reset CLI, below).
2. Deploy the migration first (`prisma migrate deploy`). It only adds tables; the old API keeps working against the new schema.
3. Deploy the new API with `TWO_FACTOR_ENCRYPTION_KEY` set. Until it is set the Account page shows "not available on this server yet" and sign-in is unchanged.
4. Verify with a disposable test admin, then roll out.
5. **Rollback:** redeploy the previous API. Enrolled admins then sign in with the password only (the old API does not know the challenge); to keep protection, do not roll back past this release once admins have enrolled. The three tables can stay.

## Initial rollout for existing admins

Nothing changes until an admin opts in. Ask each admin to open Account settings, Two-step verification, Set up. Sequence for the first admin: enroll, save recovery codes, sign out, sign back in with a code, **then** enroll the next. Keep at least two admins able to reach the system, and never be the only admin without recovery codes.

## Enrollment (admin)

1. Account settings, "Set up two-step verification", confirm the current password.
2. Scan the QR code (or enter the setup key by hand: account type "time-based").
3. Enter the 6-digit code. Only now is 2FA switched on (a pending enrollment never challenges sign-in; it expires after 15 minutes).
4. Save the 10 recovery codes (shown once; copy/download), tick the acknowledgement, Done.

Regenerate codes (password + authenticator code) invalidates all previous codes. Disable needs password + authenticator or recovery code. A code that was just used for sign-in cannot be reused: wait for the next one.

## Lost device (operator procedure)

There is intentionally **no email or self-service reset**: admin email addresses are not verified, so an emailed link would defeat the second factor.

1. Verify the admin's identity out of band (a person who knows them, a call). Record the ticket.
2. With `DATABASE_URL` pointing at the target database (check it first), dry run:
   ```
   DRY_RUN=1 CURRENT_EMAIL=admin@example.com CONFIRM_EMAIL=admin@example.com \
   RESET_REASON="OPS-123: phone lost, identity verified by video call" corepack pnpm --filter @printout/api admin:2fa-reset
   ```
3. Run it again without `DRY_RUN`. Container form: `node dist/prisma/reset-admin-2fa.js`.
4. The CLI refuses non-admins, accounts without 2FA, a mismatched `CONFIRM_EMAIL`, or a missing/short `RESET_REASON`; removes the enrollment and recovery codes, ends all sessions and writes `admin.2fa.cli_reset` (reason, OS user, host). It never touches a password, never creates an account, never needs the encryption key and prints no secret.
5. The admin signs in with their password and enrolls again immediately.

## Encryption-key rotation

1. `openssl rand -base64 32` for the new key.
2. Deploy with `TWO_FACTOR_ENCRYPTION_KEY=<new>` and `TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS=<old>`.
3. Run `corepack pnpm --filter @printout/api admin:2fa-rekey` (`DRY_RUN=1` first) with both variables set. It re-seals every row under the new key with compare-and-swap, aborts before writing if any row cannot be opened, prints counts only.
4. When it reports `0 row(s) still on an old key`, remove `..._PREVIOUS` and redeploy. Destroy the old key.

Recovery codes are Argon2id hashes and are independent of this key. Suspected key compromise: rotate as above and ask admins to disable and re-enroll (new TOTP secrets).

## Troubleshooting

| Symptom | Cause / action |
| --- | --- |
| "not available on this server yet" | `TWO_FACTOR_ENCRYPTION_KEY` unset. Set it and redeploy. |
| Enrolled admin gets 503 `TWO_FACTOR_UNAVAILABLE` at sign-in | Key unset, wrong, or the secret cannot be opened. Restore the key (incl. `..._PREVIOUS`), or use `admin:2fa-reset`. |
| "That code is not valid" with the right app | Phone clock off by more than 30 s (enable automatic time), or the code was already used (wait for the next one). |
| 429 on the code step | Too many wrong codes; wait out `LOGIN_FAIL_WINDOW_MINUTES` (restart of the API clears the in-memory counter). |
| "Your sign-in expired" | Challenge older than 5 minutes, used up or replaced; re-enter the password. |
| Out of recovery codes | Sign in with the authenticator and regenerate; if both are lost use the reset CLI. |

## Audit events

`auth.2fa.challenge_issued`, `auth.2fa.failed {method, reason: invalid|replay}`, `auth.login {secondFactor}`, `auth.2fa.recovery_code_used {remaining}`, `admin.2fa.enroll_started`, `admin.2fa.enabled`, `admin.2fa.code_rejected`, `admin.2fa.recovery_codes_regenerated`, `admin.2fa.disabled`, `admin.2fa.cli_reset`, `admin.2fa.rekey`, plus the existing `admin.account.reauth_failed` with `operation` `2fa_enroll|2fa_regenerate|2fa_disable`.
