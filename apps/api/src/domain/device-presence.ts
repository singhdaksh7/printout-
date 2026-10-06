/**
 * Device presence semantics (single source of truth; the dashboard and API both use this).
 *
 * Devices send POST /device/heartbeat every HEARTBEAT_INTERVAL_SECONDS (60 s). The server records lastSeenAt at most once per
 * DEVICE_LASTSEEN_WRITE_INTERVAL_SECONDS (default 30 s), so stored lastSeenAt can lag real contact by up to that long.
 * A device is ONLINE when lastSeenAt is within ONLINE_THRESHOLD_SECONDS (3 missed intervals = 180 s), otherwise OFFLINE
 * (also when it has never been seen). Revoked devices are always REVOKED. Presence is "recently heard from", not a live socket.
 */
export const HEARTBEAT_INTERVAL_SECONDS = 60;
export const ONLINE_THRESHOLD_SECONDS = 3 * HEARTBEAT_INTERVAL_SECONDS;

export type DevicePresence = 'ONLINE' | 'OFFLINE' | 'REVOKED';

export function devicePresence(
  device: { status: 'ACTIVE' | 'REVOKED'; lastSeenAt: Date | null },
  nowMs: number = Date.now(),
  onlineThresholdSeconds: number = ONLINE_THRESHOLD_SECONDS
): DevicePresence {
  if (device.status === 'REVOKED') return 'REVOKED';
  if (!device.lastSeenAt) return 'OFFLINE';
  return nowMs - device.lastSeenAt.getTime() <= onlineThresholdSeconds * 1000 ? 'ONLINE' : 'OFFLINE';
}
