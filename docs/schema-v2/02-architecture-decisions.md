# 02 – Architecture decisions (proposed, pending owner approval)

Status: **PROPOSED**. Nothing here is implemented. Items marked **[APPROVAL]** need owner approval before any code or migration ships.

| ID | Decision | Rationale |
|---|---|---|
| AD-1 | The PDF is the product target; the repository stays authoritative for infrastructure. No literal adoption of the 11-table schema. | Sessions, devices, 2FA, hours, print path and billing tables have no PDF equivalent. |
| AD-2 | Keep Prisma model and enum names; map PDF names in `04`. No table renames. | Renames break Android, the agent and history queries. |
| AD-3 | Keep the app's own access/refresh tokens. Firebase ID tokens are exchanged once at `POST /auth` (customers included). The PDF's "ID token on every call" is **not** adopted. **[APPROVAL]** | Replay protection, revocation, device binding and 2FA depend on it. See 06. |
| AD-4 | Customers are a new principal: add `CUSTOMER` to `Role` (additive) and allow users without a shop. Multi-role is a new `UserRoleGrant` table, not a change of `User.role` to an array. | `User.role` is a scalar used by guards everywhere. |
| AD-5 | Customers sign in with Firebase Google or phone OTP only (no password). `User.email` and `passwordHash` are currently required; making `email` nullable is an expand step. **[APPROVAL]** | |
| AD-6 | No automatic identity linking by email or phone. The PDF's "claim by phone" login step and "reuse user by phone" on admin create are **rejected**; the existing explicit, re-authenticated linking stays. | Existing security rule (see `UserGoogleIdentity` comment). |
| AD-7 | Multi-shop uses `Membership` (exists, backfilled) as the owner-to-shop link. `User.shopId` remains the default/legacy shop. Shop id is a path parameter on new routes, always checked against `Membership`. Legacy `/shop/*` routes resolve to the default shop. | No caller-controlled tenant switching without a membership check. |
| AD-8 | Pricing stays per sheet. The PDF's per-page rate is not stored as a replacement. A per-page projection is shown only where exact (single-sided). Per-page pricing as a real model needs approval. **[APPROVAL]** | A duplex sheet is two pages; reinterpretation would misprice. |
| AD-9 | Verification (`isVerified`) is a new additive Shop flag, separate from `ShopStatus` and from `Subscription`. Existing shops are backfilled verified so none disappears from discovery. | Free immediate signup is preserved. |
| AD-10 | PostGIS is optional. Phase 2 first ships latitude/longitude doubles with bounding-box plus haversine and a btree index; PostGIS only after production confirms `CREATE EXTENSION postgis` is permitted. **[APPROVAL]** | Avoid a hard dependency on a provider permission. |
| AD-11 | One order state machine in a domain module; the DB enum is extended additively (`REJECTED`), PDF names are API aliases. See 08. | |
| AD-12 | Customer ordering reuses the existing pricing and validation. The guest QR flow is untouched. Authenticated orders add nullable `customerUserId`. | |
| AD-13 | Payments track customer-to-shop settlement only, in a new `OrderPayment` table separate from the dormant platform `Payment`. No gateway. **[APPROVAL]** | Keeps platform billing out. |
| AD-14 | Post-print retention stays at 30 minutes until the owner approves a change (see 09). **[APPROVAL]** | Privacy-significant. |
| AD-15 | New customer endpoints are additive under `/api/v1/customer/...`; multi-shop owner routes under `/api/v1/shops/{shopId}/...`. Existing routes are never repurposed. | |
| AD-16 | Envelopes stay as today (`{error:{...}}`, `{data}`); the PDF's flat error shape is not adopted. | Android already parses it. |
| AD-17 | Windows agent, `DevicePrintJob` and Phase B are out of scope until `feature/daksh-phase-b-smart-print-printers` is merged or coordinated. | |

## Open questions for the owner

1. Is the customer marketplace (accounts, discovery, reviews) in scope for the next release, or only multi-shop for owners?
2. Per-page vs per-sheet pricing in the customer app.
3. Retention: stay at 30 minutes, or move to 7 days?
4. May PostGIS be enabled on the production database?
5. Is UPI tracking required in v1 given shops verify UTRs manually?
6. Referral codes: required or skip?
