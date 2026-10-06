import { describe, expect, it } from 'vitest';
import { DEVICE_CREDENTIAL_PREFIX, generateDeviceCredential, hashDeviceCredential } from '../src/device-auth.js';
import { devicePresence, ONLINE_THRESHOLD_SECONDS } from '../src/domain/device-presence.js';

describe('device foundation', () => {
  it('credentials are high-entropy, prefixed, unique and only their sha256 digest is derived', () => {
    const a = generateDeviceCredential();
    const b = generateDeviceCredential();
    expect(a.secret.startsWith(DEVICE_CREDENTIAL_PREFIX)).toBe(true);
    expect(a.secret.length).toBeGreaterThanOrEqual(DEVICE_CREDENTIAL_PREFIX.length + 43);
    expect(a.secret).not.toBe(b.secret);
    expect(a.hash).toBe(hashDeviceCredential(a.secret));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.secret);
  });

  it('presence: ONLINE within the threshold, OFFLINE after it or when never seen, REVOKED always wins', () => {
    const now = Date.now();
    const ago = (s: number) => new Date(now - s * 1000);
    expect(devicePresence({ status: 'ACTIVE', lastSeenAt: ago(10) }, now)).toBe('ONLINE');
    expect(devicePresence({ status: 'ACTIVE', lastSeenAt: ago(ONLINE_THRESHOLD_SECONDS) }, now)).toBe('ONLINE');
    expect(devicePresence({ status: 'ACTIVE', lastSeenAt: ago(ONLINE_THRESHOLD_SECONDS + 1) }, now)).toBe('OFFLINE');
    expect(devicePresence({ status: 'ACTIVE', lastSeenAt: null }, now)).toBe('OFFLINE');
    expect(devicePresence({ status: 'REVOKED', lastSeenAt: ago(1) }, now)).toBe('REVOKED');
  });
});
