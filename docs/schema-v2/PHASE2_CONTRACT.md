# Phase 2 contract: discovery

Status: **IMPLEMENTED on branch `feature/daksh-schema-v2-phase2-discovery`; becomes CURRENT_PRODUCTION only when `IMPLEMENTATION_PROGRESS.md` says DEPLOYED with evidence.** All routes are additive; no existing route changed except two additive fields on the admin shop view (`isVerified`, `verifiedAt`) and an optional `isVerified` filter on `GET /admin/shops`.

## Customer routes (customer session; owners/admins get 403, anonymous 401)

| Route | Notes |
|---|---|
| `GET /customer/shops/nearby?lat&lng&radiusKm&printingType&page&limit` | `lat` -90..90, `lng` -180..180 required; `radiusKm` default 5, max 20 (above 20 is `400`); `printingType` `colored` or `blackWhite` (shops with an active rate of that colour mode); `limit` default 20, max 50. Response `{ data: { items: [card + distanceKm], page, limit, total } }`, ordered by distance then id. Only **verified, ACTIVE shops with coordinates**. Closed shops are listed with `isOpen: false`. Rating is not ranked yet (no ratings until phase 5). Unknown query keys are `400`. |
| `GET /customer/shops/{shopId}` | Card plus `location`. Unverified, suspended or unknown shops are `404`. |
| `GET /customer/shops/{shopId}/images/{imageId}` | Streams a private photo through the API (`content-type` from the verified type, `nosniff`, `private` cache). Never a storage URL. |

Card fields: `id, shopName, phoneNumber, addressLine1/2, city, state, pincode, isOpen, acceptsOrders, availability{state,reason,nextOpenAt,closesAt,orderingBlocked}, rates[{paperSize,colourMode,sides,pricePerSheetPaise}], paperSizes, paperTypes, images[{id,url,sortOrder}], ratingAvg (null), ratingCount (0)`. Prices are **per sheet** (decision D2); the authoritative price is always recalculated server-side at quote/order time. No owner email/phone, devices, subscription or audit data is ever returned.

## Owner routes (owner session; `/shops/{shopId}` is checked against the caller's own shops, a foreign id is `404`)

| Route | Notes |
|---|---|
| `GET /shops/{shopId}` | Card plus `shopStatus, isActive, isVerified, verifiedAt, country, slug`. |
| `PATCH /shops/{shopId}` | Strict body: `shopName, phoneNumber (E.164 or null), addressLine1, addressLine2, city, state, pincode, latitude+longitude (together), isOpen`. `isVerified`, `status`, `isActive`, `slug` are `400`. `isOpen: true` needs an ACTIVE shop (`422 SHOP_NOT_ACTIVE`) and at least one active rate (`422 RATE_NOT_SET`); closing is always allowed. `isOpen` maps to the existing `acceptsOrders`. Deviation from the PDF: opening does **not** require verification, because verified-only would break guest QR ordering of existing/new shops; verification gates *discovery* only. |
| `PUT /shops/{shopId}/paper-options` | `{ paperSizes[], paperTypes[] }`. A size can be advertised only if the shop has an active rate for it; the only paper type priced today is `normal` (others `400 UNSUPPORTED_PAPER`, no A3/glossy/matte claims). Atomic replace; audited. |
| `POST /shops/{shopId}/images` | Raw body `image/jpeg` or `image/png`, max 2 MiB, magic-byte verified (the declared type is ignored), max 8 photos (`409`), opaque random storage key, DB row `ShopImage`. `201 { id, url, sortOrder }`. |
| `GET /shops/{shopId}/images/{imageId}`, `DELETE ...` | Owner view and removal (`204`; object deleted). |

## Admin routes (admin session + 2FA as today)

| Route | Notes |
|---|---|
| `GET /admin/shops?isVerified=true|false` | Verification queue. |
| `PATCH /admin/shops/{id}/verify` | `{ isVerified }`; sets `verifiedAt/verifiedBy`; audit `shop.verify`/`shop.unverify` with `{before, after}`. Idempotent. |
| `PATCH /admin/shops/{id}/block` | `{ isActive }`; block = `SUSPENDED` with the same immediate session/refresh lock-out as `PUT /admin/shops/:id`; unblock only lifts `SUSPENDED` (a `PILOT` shop is untouched). Audit `shop.block`/`shop.unblock`. |

## Database (migration `20261028110000_shop_discovery`)

Additive: `Shop` address line 2, city, state, country (default `IN`), latitude, longitude (range and pairing CHECKs), `isVerified`, `verifiedAt`, `verifiedBy`, indexes `(isVerified,status)` and `(latitude,longitude)`; tables `ShopPaperOption` (CHECK `kind IN ('paperSize','paperType')`) and `ShopImage`. Backfill (restartable): every existing ACTIVE shop is marked verified so none leaves discovery; paper sizes are seeded from each shop's active pricing rules. Verified on a disposable PG16 upgrade with seeded shops (ACTIVE verified, PILOT not; sizes A3 and A4 seeded) and `prisma migrate diff` shows no drift.

## Geo backend

`GEO_BACKEND=haversine` (default): bounding-box + haversine, no extension. `postgis`: ST_DWithin on a geography, optional GiST index; falls back automatically if the extension is missing. See `POSTGIS_RUNBOOK.md`.

## Android notes

Existing owner app: no change. Customer app: use the three customer routes above; show `isOpen`/`availability` from the server (never from the device clock); image `url` values are API paths to be fetched with the bearer token.
