# Shop operating hours and availability

Branch `feature/daksh-shop-hours`. Lets a shopkeeper configure when the shop operates, shows customers accurate open/closed information, and optionally blocks new customer orders while the shop is closed. No scheduled printing and no automatic print initiation exist or are implied.

## Semantics (authoritative)

**Timezone.** `ShopSettings.timezone` is an IANA name (default `Asia/Kolkata`, UTC+05:30, no DST). Hours, closure dates and "today" are all interpreted in this zone. DST zones are supported by the calculation (wall-clock to UTC conversion per date; a time inside a spring-forward gap resolves forward).

**Weekly schedule** (`ShopSettings.operatingHours`, JSON, or `NULL` = no schedule):

```json
{ "mon": [{"start":"09:00","end":"13:00"},{"start":"14:00","end":"18:00"}], "tue": [], "wed": [], "thu": [], "fri": [{"start":"21:00","end":"02:00"}], "sat": [], "sun": [{"start":"00:00","end":"24:00"}] }
```

- All seven keys (`mon`..`sun`) are required; `[]` = closed that day. Up to 6 intervals per day.
- `start` is `HH:MM` 00:00-23:59 (24-hour). `end` is `HH:MM` or `24:00` (midnight at the end of the day).
- An interval belongs to the local day it **starts** on. `start` inclusive, `end` exclusive.
- `end <= start` (for example `21:00`-`02:00`) means the shop stays open past midnight into the next local day. `start == end` is invalid. `00:00`-`24:00` is a 24-hour day; it cannot share a day with other intervals.
- Overlap is rejected across the whole week, including an overnight interval spilling into the next day and Sunday spilling into Monday. Touching intervals (`13:00` end, `13:00` start) are allowed and merge into one open spell.
- `NULL` (no schedule) means **availability is unknown**: the customer page claims nothing and ordering is unrestricted (this is the state of every existing shop).

**Special closures** (`specialClosures`, JSON array `[{ "date":"YYYY-MM-DD", "reason":"Diwali" }]`): the **whole local calendar date** is closed, including the after-midnight tail of the previous day's overnight interval. Unique dates, real calendar dates, up to 366. Past dates are kept (nothing is deleted silently). Reasons are shown to customers.

**Temporary closure** (`temporaryClosure`, JSON `{ reason, startedAt, until }` or `NULL`): closes the shop immediately, overriding the schedule, until `until` (optional; absent = until the shopkeeper reopens). A lapsed `until` stops applying by itself (the row is not erased). `nextOpenAt` after a closure with `until` is the first scheduled opening at or after `until`.

**Emergency reopen** (`reopenUntil`, timestamp or `NULL`): until that instant the shop counts as open regardless of the schedule, special closures and temporary closure. 5 minutes to 24 hours. Starting a temporary closure clears it.

**Precedence:** emergency reopen > temporary closure > special closure > weekly schedule > no schedule (unknown).

**After-hours policy** (`afterHoursPolicy`): `ACCEPT` (default, the existing behaviour) or `BLOCK`. With `BLOCK`, whenever the computed state is `closed` (for **any** closure reason: outside hours, special closure or temporary closure), new customer uploads, quotes and orders are rejected with `409 SHOP_CLOSED`. With `ACCEPT` closure is informational only. `unknown` (no schedule) never blocks. The older manual `Shop.acceptsOrders` switch and subscription rules are independent and unchanged.

**Never affected:** order tracking (`GET /public/orders/:token`), the shopkeeper's queue and order actions, existing orders (nothing is cancelled when the shop closes), customer documents and their privacy, and idempotent replays of an order the server already created.

## Race safety

The order transaction already row-locks the `Shop` row (order counter increment). It now evaluates availability **after** taking that lock, against the settings committed at that moment. Every hours mutation also touches the `Shop` row first, so each order is evaluated either fully before or fully after a settings change; there is no window where an order slips in after a committed closure. A rejected attempt rolls back, consuming no order number. A fast pre-check before the transaction and checks at upload initiation and quote give early, friendly errors; the in-transaction check is the authoritative one.

## Availability result

Computed only on the server (`apps/api/src/domain/hours.ts`, pure and unit tested) from authoritative settings and the server clock. The browser formats the returned instants in the shop's timezone and never decides open/closed itself. The page re-fetches every 60 seconds and when the tab becomes visible.

```
{ serverTime, timezone, state: "open"|"closed"|"unknown",
  reason: "schedule"|"outside_hours"|"special_closure"|"temporary_closure"|"emergency_reopen"|"not_configured",
  closureReason, closesAt, nextOpenAt, orderingBlocked, afterHoursPolicy,
  today: { date, day, closedAllDay, reason, intervals } | null, weeklyHours | null,
  upcomingClosures (next 60 days), temporaryClosure: { reason, until } | null }
```

`nextOpenAt` is searched up to about three weeks ahead and is `null` when it cannot be calculated. Corrupt stored JSON degrades to "no schedule" rather than failing requests.

## API

Shop (owner session, CSRF on mutations, tenant = session shop; a shop id in the body is rejected):

| Endpoint | Behaviour |
| --- | --- |
| `GET /shop/hours` | `{ timezone, weeklyHours\|null, specialClosures, afterHoursPolicy, temporaryClosure\|null, reopenUntil\|null, updatedAt, availability }` |
| `PUT /shop/hours` | Any of `timezone`, `weeklyHours` (object or `null` = explicitly remove the schedule), `specialClosures` (full replacement list), `afterHoursPolicy`. Omitted fields are untouched; temporary closure and reopen are never altered by this call. Strict validation, `400 VALIDATION_ERROR`. |
| `PUT /shop/hours/temporary-closure` | `{ reason?, until? }`; `until` must be in the future (at most one year). Clears any emergency reopen. |
| `DELETE /shop/hours/temporary-closure` | Reopens. |
| `POST /shop/hours/reopen` | `{ minutes: 5..1440 }` emergency reopen. |
| `DELETE /shop/hours/reopen` | Ends emergency reopen. |

Public: `GET /public/shops/:slug` gains an additive `availability` object (above). `409 SHOP_CLOSED` (`details: { nextOpenAt, reason }`) is returned by `POST /public/shops/:slug/uploads/initiate`, `POST .../quotes` and `POST .../orders` when the policy blocks. Existing clients that ignore `availability` keep working; `acceptsOrders` keeps its previous meaning.

Every mutation is audited (`shop.hours.update`, `shop.hours.temporary_closure.set|clear`, `shop.hours.reopen|reopen.clear`) with the actor and changed field names only.

## Schema and migration

Migration `20261017100000_shop_operating_hours` (additive, forward-only, no backfill): enum `AfterHoursPolicy (ACCEPT, BLOCK)`; on `ShopSettings`: `timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'`, `operatingHours JSONB NULL`, `specialClosures JSONB NOT NULL DEFAULT '[]'`, `temporaryClosure JSONB NULL`, `reopenUntil TIMESTAMP(3) NULL`, `afterHoursPolicy NOT NULL DEFAULT 'ACCEPT'`. Existing shops therefore keep exactly today's behaviour. Rollback: the new columns are unused by older code; to revert, deploy the previous API and drop the columns and enum in a later, separately approved migration. Verified on a disposable PostgreSQL with `prisma migrate deploy` and `prisma migrate diff` (no drift). Production was not touched.

## UI

Shopkeeper: Settings, new "Operating hours" card (`apps/web/src/shop/HoursSection.tsx`, `hours.css`) built from the shared `ui` library (Card, Switch, TextField, Select, RadioGroup, Banner, Chip, Button, IconButton) and `--pb-*` tokens: current status, close-now / reopen-now controls (immediate), weekly schedule with per-day switch, multiple intervals, open 24 hours, overnight hint, timezone, holiday list, after-hours policy, Save and Cancel changes with inline validation (a client mirror of the server rules) and a toast on success. Turning the schedule off only saves `weeklyHours: null` when the shopkeeper presses Save.

Customer (`/p/:slug`): `apps/web/src/customer/AvailabilityPanel.tsx`: status chip, closing or next opening time, today's hours, closure reason, an accessible native `<details>` for weekly hours (a table with row headers, today marked `aria-current`) and upcoming closures. When blocked, the upload flow is replaced by a "Closed for new orders" notice with a link to track the last order. With state unknown nothing is claimed.

## Known limitations

- Per-shop timezone choice offers a short list (the API accepts any IANA name).
- One schedule per week (no seasonal or date-range schedules); special closures are whole days only (no partial-day special hours).
- The manual `acceptsOrders` switch and the temporary closure are separate controls by design (the former is a hard pause that always blocks).
- Customers see an updated state within 60 seconds or when they return to the tab; order attempts are always checked live by the server.
- Android clients are not updated; they ignore `availability` and will receive `SHOP_CLOSED` errors when blocked.
