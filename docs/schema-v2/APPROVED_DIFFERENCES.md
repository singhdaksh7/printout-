# Approved differences from printout_buddy_schema.pdf

Recorded 2026-11-02 on the owner's instruction. These are explicit, approved departures from the 23-page PDF. They are not gaps and must not be "fixed" toward the PDF without a new owner decision. Because of them, **literal 100% PDF parity is not claimed**.

| # | Topic | PDF says | Approved behaviour | Why |
|---|---|---|---|---|
| 1 | Upload size | Max 20 MB | **50 MiB** (`UPLOAD_MAX_BYTES`) | Existing approved product policy; Caddy limit moves with it |
| 2 | Document retention | 7 days after end; orphan 24 h | **30 minutes** after Print is pressed | Privacy policy; files are not kept |
| 3 | Pricing | `pricePerPagePaise × pages × copies` | **Server-authoritative per-sheet** pricing, duplex = 2 pages per sheet | Real printing cost model; the PDF per-page value is an adapter projection only |
| 4 | Payments | cash / UPI | Customer **cash/UPI tracking** only; no payment processing | Matches PDF intent; no gateway |
| 5 | Refunds | Admin sets `refunded` | **Admin-only manual authorization** via the existing admin refund route | Same |
| 6 | Authentication | Firebase ID token on every call | **App-issued bearer access + rotating refresh token**; the Firebase ID token is accepted only by `POST /auth/login` (exchange) and web Google sign-in | Revocation, device binding, 2FA, cookie sessions for web |
| 7 | Identity linking | Phone claim matches admin-created owner; new users auto-created | **No automatic linking by email or phone**; owners link Google only with proof of the existing credential (recovery flow) | Account-takeover prevention |
| 8 | Referrals | Referral code on first login | **Deferred** (accepted and ignored) | Not in scope |
| 9 | New-user role | Every new user is `customer` immediately | New users pass the existing restricted onboarding step before an account row is created | Approved onboarding policy |
| 10 | Subscriptions | None in free phase | Legacy subscription/plan tables and admin routes remain in the database/API for history; **no plan or subscription UI** is shown | Do not destroy records |
| 11 | Contract selection | One shape per path | Paths already used by production clients keep their app shape; PDF shape is selected with `X-API-Contract: pdf`. PDF-only paths always answer in the PDF shape | Backward compatibility |
| 12 | Error shape | `{ code, message, details }` | PDF shape on PDF requests; app envelope `{ error: { code, message, requestId } }` elsewhere | Backward compatibility |
