# Real-time order notifications

Status: implemented on `feature/daksh-realtime-notifications`. Applies to the shop (owner) dashboard only.

## 1. Architecture decision

The repository already had the right transport: an authenticated, shop-scoped **SSE** stream (`GET /shop/events`) with heartbeat, caps, proxy-safe headers and a single shared browser connection (`RealtimeProvider`). A second notification system was **not** added. What was missing:

| Gap in the existing bus | Resolution |
|---|---|
| Events lived in a per-process memory ring buffer: lost on API restart, not visible to a second process | **Transactional outbox**: a `ShopNotification` row is written in the order-creation transaction. The database is the source of truth. |
| No read/unread state, no history | `readAt` per notification, cursor-paginated inbox API |
| Browser could only learn "something changed" | `notification.created` event carrying safe metadata, deduplicated by notification id |
| One-process limitation | Bounded poller (no Redis/broker) so another API process's notifications also reach open streams |

SSE is used (server → browser only). WebSockets, a broker and Redis were rejected as unnecessary infrastructure for the current single-VPS topology (`deploy/docker-compose.prod.yml`: one `api`, one `worker`, Postgres, Caddy).

Note: production routing in this repository is **Caddy** (`deploy/Caddyfile`), not Traefik. No proxy/Docker/VPS change is required or made.

## 2. Delivery model and guarantees

1. `POST /public/shops/:slug/orders` creates the order, bumps `Shop.orderCounter` (row lock on the shop) and inserts the `ShopNotification` in **one transaction**. Rollback removes both. A failure to write the notification therefore fails the order (atomicity was chosen over best effort; the insert is a single trivial statement in the same transaction).
2. After commit the process calls `hub.publish` (fast path). This is wrapped so any fan-out failure cannot affect the customer response; the row already exists.
3. While at least one stream is open, each API process polls `ShopNotification` for `seq > cursor` every `NOTIFICATION_POLL_MS` (default 3000) and delivers rows created by *other* processes. The poller stops when the last stream closes. `NOTIFICATION_POLL_MS=0` disables it (single-process deployments still get instant delivery).
4. Per subscriber, `seq` must increase: duplicates (fast path + poller) and reordering are dropped. Per shop, `seq` order equals commit order because order creation holds the shop row lock until commit.
5. Clients recover anything missed with `GET /shop/notifications?after=<latest seq>`, on reconnect and on tab resume.

Guarantee: **at-least-once to the database, at-most-once-per-id in the UI.** A committed order always has a notification; the browser sees it live if connected, otherwise on next reconcile. Live push is best effort by design. Limits: a stream receives at most `NOTIFICATION_POLL_MS` late for orders taken by another process; notifications older than `NOTIFICATION_RETENTION_DAYS` are not recoverable.

## 3. Event / data schema

Table `ShopNotification` (migration `20261016195159_shop_notifications`, additive only):
`id` (cuid, PK), `seq` (BIGSERIAL, unique, replay cursor), `shopId` (FK, cascade), `type` (`order.created`), `orderId` (FK, cascade), `dedupeKey` (`order.created:<orderId>`, unique per shop → idempotent), `payload` (`{orderId, orderNumber}`), `readAt`, `createdAt`. Indexes: `(shopId, seq)`, `(shopId, readAt)`, `(createdAt)`.

API shape (never contains document names, storage keys, URLs, tracking tokens or customer references):

```json
{ "id": "ckx…", "seq": "42", "type": "order.created", "createdAt": "2026-10-16T…Z", "readAt": null,
  "data": { "orderId": "ckx…", "orderNumber": "CENTRA-0004" } }
```

SSE frame on `/shop/events` (no `id:` field, so the legacy `Last-Event-ID` space is untouched):

```
event: notification.created
data: {…the object above…}
```

## 4. Endpoints (all owner session, shop-scoped; mutations need `x-csrf-token`)

* `GET /shop/notifications?limit=1..50(20)&cursor=<seq>&after=<seq>&unreadOnly=` → `{ items[] (newest first), nextCursor|null, hasMore, latestCursor|null, unreadCount }`. `cursor` pages to older, `after` catches up to newer; unknown parameters are rejected (400).
* `POST /shop/notifications/:id/read` → `{ notification, unreadCount }`; idempotent. Another shop's id → `404 NOT_FOUND` (indistinguishable from unknown).
* `POST /shop/notifications/read-all` → `{ updated, unreadCount }`; only the caller's shop.
* `GET /shop/events` additionally streams `notification.created`.

Read state is per shop (all staff of a shop share one inbox). Proposed `/shop/notifications/stream` was intentionally **not** added: the existing stream is reused so each tab holds one connection.

## 5. Security

* Auth (`shopGuard`: valid session, `SHOP_OWNER`, shop ACTIVE) on connect and on every request; CSRF on mutations.
* **Delivery-time revalidation**: before each notification is written the session is re-checked in the database (invalidated/expired session or suspended shop → stream closed, nothing written). The heartbeat re-check (≤25 s) closes idle streams the same way.
* Tenant isolation: every query includes the session's `shopId`; the hub routes by `shopId`; the client never supplies a shop id. DTOs are whitelisted field by field (`toNotificationDto`), and the browser re-validates pushed data (`parseNotification`).
* Caps: `SSE_MAX_CONNECTIONS_PER_SHOP` (10), `SSE_MAX_CONNECTIONS_PER_SESSION` (5, new), `RATE_LIMIT_SSE_CONNECT_MAX` (30/min/session), list `RATE_LIMIT_SHOP_READ_MAX`, mutations `RATE_LIMIT_SHOP_MUTATION_MAX`.
* Bounded memory: at most 100 queued notification writes per stream and a 256 KiB write backlog; a slow consumer is disconnected and reconciles from the database. Disconnects (including abrupt) remove listeners; the poller stops with the last listener and on server close.
* Logs: hub errors log only the error class; payloads, ids and cookies are never logged (cookies/CSRF are already redacted by the request logger).
* Proxy: `Cache-Control: no-store, no-cache, no-transform`, `X-Accel-Buffering: no`; Caddy already flushes immediately, has `read_timeout 0` and no `encode` on the API route. No change needed.

## 6. Retention

`NOTIFICATION_RETENTION_DAYS` (default 14, 1–365). Older rows are hidden by the API immediately and deleted by the retention worker (hourly, own try/catch so it can never delay document deletion; batches of 500). Notifications are never needed for audit: orders and `AuditLog` are unchanged.

## 7. Browser behaviour

* One `EventSource` per tab (shared `RealtimeProvider`), exponential backoff 1 s → 30 s, `online` triggers an immediate retry; on becoming live after a gap or when the tab becomes visible again the inbox is reconciled with `?after=`. A gap larger than 50 items falls back to reloading the first page.
* Toast + screen-reader announcement (`role=status`, polite) per new order; toast shows a "View order" link to `/shop/orders/:id`. Several tabs: a `localStorage` claim (atomic via the Web Locks API) lets one tab toast/ring; every tab still updates its list, badge and announcement.
* The Print queue refreshes itself on any realtime event (existing behaviour, debounced) including `notification.created`, so the queue and summary strip update without polling.
* **Sound**: off by default; opt-in via the "Sound for new orders" checkbox (Print queue header or notification panel; same stored preference `printout.shop.sound` as before). Per-browser because audio permission is per browser. Audio is unlocked inside the opt-in click, and again on the first click/key press after a page load. If the browser still blocks audio, no sound plays and the panel shows "Enable sound". Rings only for *live* notifications created in the last 2 minutes, at most once per 3 s; never for refresh, replay, reconnect catch-up or history. (The previous behaviour of beeping on any queue refresh that discovered a new order was removed because it rang on reload/reconnect.)
* Connection chip: Live / Reconnecting… / Offline, amber (never red). The panel explains the state; the queue keeps working (45 s refresh, focus refresh).

## 8. Operations

* Migration: `prisma migrate deploy` (additive: one new table, no data change, safe to run before or after the API roll). Roll back by dropping `ShopNotification`; nothing else references it.
* New env (all optional): `NOTIFICATION_POLL_MS`, `NOTIFICATION_RETENTION_DAYS`, `SSE_MAX_CONNECTIONS_PER_SESSION`.
* Scaling: safe for multiple API instances (poller). Rate-limit counters and the legacy ring buffer remain per process.
* Known limitations: legacy events (`order.updated`, …) are still in-memory only and are not delivered across processes; read state is per shop, not per staff member; Web Locks missing (very old browsers) degrades the multi-tab claim to best effort; push only reaches an open tab (no Web Push/OS notifications).

## 9. Tests

API: `apps/api/test/realtime-notifications.test.ts` (outbox atomic commit/rollback, idempotency, isolation, CSRF, cursors, retention, rate limit, real-socket delivery, cross-process, session/suspension revalidation, cleanup, caps, hub unit tests). Web: `apps/web/src/shop/__tests__/notifications.test.tsx`. Browser: `e2e/11-realtime-notifications.spec.ts` (two shops, live delivery, isolation, deep link, reload persistence, real stream outage + catch-up, sound opt-in, two tabs, axe, 360/390/430 px overflow).
