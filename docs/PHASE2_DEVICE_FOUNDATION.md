# Phase 2 - Device foundation

Baseline: Phase 1 (c3960dd). Phase 1 print/retention semantics are unchanged: the first Print sets `printInitiatedAt = now` and `deleteAfter = +PRINT_RETENTION_MINUTES`; reprint/save never move them; access is denied at `deleteAfter` before the worker runs; the worker deletes the object then marks DELETED.

## Architecture (one implementation each)
* Device auth: `src/device-auth.ts` (`deviceGuard`, Bearer `pbd_` credential, sha256 at rest, row read every request so revoke is immediate).
* Pairing: `src/domain/devices.ts` (code `PB-XXXX-XXXX`, 40 bits CSPRNG, HMAC at rest, 10 min single use, atomic claim, advisory-lock cap of 5 active codes per shop, failure throttle).
* Print engine: `src/domain/print-service.ts` (`initiatePrint`, `issueDocumentAccess`), used by browser routes (`routes/shop-orders.ts`) and device routes (`routes/device-orders.ts`). Actors: `SHOP_OWNER` (userId) or `SHOP_DEVICE` (deviceId) are recorded in OrderStatusHistory and AuditLog.
* Serializers: `src/domain/order-serializers.ts`; `DeviceView` in `domain/devices.ts` (matches `apps/web/src/lib/shop-api.ts`).
* Presence: `src/domain/device-presence.ts`. Heartbeat every 60 s; ONLINE when lastSeenAt is within 180 s; lastSeenAt is written at most every `DEVICE_LASTSEEN_WRITE_INTERVAL_SECONDS` (30). Presence is derived at read time, not a live connection.
* Notifications: `src/notifications/*` (`Notifier`, `DeviceNotifier`, `PushProvider`, `RecordingPushProvider`, `NoopPushProvider`). A signal is only `{type:'NEW_PRINT_REQUEST', orderId}`; devices fetch via the authenticated API.

## Schema
Additive migration `20261006120000_shop_devices`: enums DevicePlatform/DeviceStatus, tables ShopDevice and DevicePairingCode, nullable `AuditLog.actorType/actorDeviceId`, nullable `OrderStatusHistory.actorDeviceId`. No drops, no rewrites; ADD COLUMN nullable is metadata-only (instant). Verified: fresh `migrate deploy` has no drift; applied on top of a Phase 1 database with data preserved.

## Default notifier decision
`createApp` keeps `NoopNotifier` by default (`deps.notifier` overrides). `DeviceNotifier` with the no-op provider would add a DB query per order and send nothing. Wire `new DeviceNotifier(prisma, <real provider>)` in `server.ts` when an FCM provider exists.

## Housekeeping
The worker sweeps `DevicePairingCode` rows older than 24 h (hourly, separate try/catch, never affects document deletion). ShopDevice rows are never purged. Per-IP limiter buckets use the IPv6 /64 prefix.

## NOT built
FCM/real push provider, device apps, credential rotation endpoint, push-token encryption at rest (future), cross-process SSE, per-device audit viewer in the UI.

## Security notes and residual risks
Pairing code is 40 bits, bounded by per-client and global throttles (in memory, per API process; multi-instance deployments multiply the ceilings). Anyone holding a live code can pair a device until it expires, so the UI warns the owner. A stolen credential works until revoked. Push tokens are stored in clear text. Throttles reset on restart.

## Deploy notes
`prisma migrate deploy` only (never db push/reset). Production compose already uses connection pool=5. `TRUST_PROXY_CIDRS` must remain set, otherwise all clients share one IP and the per-IP limiters/pairing throttle degrade.
