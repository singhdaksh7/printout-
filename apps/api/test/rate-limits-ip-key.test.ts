import { describe, expect, it } from 'vitest';
import { clientIpKey } from '../src/rate-limits.js';

describe('clientIpKey (per-IP limiter bucket)', () => {
  it('leaves IPv4 unchanged', () => {
    expect(clientIpKey('203.0.113.5')).toBe('203.0.113.5');
    expect(clientIpKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });
  it('collapses IPv6 to its /64 prefix', () => {
    expect(clientIpKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(clientIpKey('2001:db8:1:2::1'));
    expect(clientIpKey('2001:DB8:0001:2::ffff')).toBe(clientIpKey('2001:db8:1:2:1:2:3:4'));
    expect(clientIpKey('2001:db8:1:3::1')).not.toBe(clientIpKey('2001:db8:1:2::1'));
    expect(clientIpKey('2001:db8:1:2::1')).toBe('v6:2001:db8:1:2');
    expect(clientIpKey('::1')).toBe('v6:0:0:0:0');
  });
  it('tolerates a missing ip', () => {
    expect(clientIpKey(undefined)).toBe('unknown');
  });
});
