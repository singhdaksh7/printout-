# Device presence

* Devices call `POST /api/v1/device/heartbeat` every **60 s** (`HEARTBEAT_INTERVAL_SECONDS`).
* The server writes `lastSeenAt` at most once per `DEVICE_LASTSEEN_WRITE_INTERVAL_SECONDS` (default 30 s) using a conditional update; a changed `appVersion`/`osVersion` is persisted immediately. Heartbeats are not audited.
* **ONLINE**: `lastSeenAt` within **180 s** (`ONLINE_THRESHOLD_SECONDS`, three missed intervals). **OFFLINE**: older, or never seen. **REVOKED**: always wins.
* Presence means "recently heard from", not a live socket. Use `devicePresence()` from `src/domain/device-presence.ts`.
* Revoked, suspended-shop and inactive-subscription devices are refused by `deviceGuard` (401/403) and so cannot heartbeat.
