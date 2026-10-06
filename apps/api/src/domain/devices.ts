import { randomBytes } from 'node:crypto';
import type { DevicePlatform, PrismaClient, ShopDevice } from '@prisma/client';
import type { Config } from '../config.js';
import { generateDeviceCredential } from '../device-auth.js';
import { AppError } from '../errors.js';
import { clientIpKey } from '../rate-limits.js';
import { audit } from '../routes/context.js';
import { deriveSecret, hmacHex } from '../storage/keys.js';
import { subscriptionAllowsIntake } from './eligibility.js';
import { devicePresence, HEARTBEAT_INTERVAL_SECONDS } from './device-presence.js';

/**
 * Pairing codes: `PB-XXXX-XXXX`. 8 characters from a 32-symbol alphabet without look-alikes (no 0/O/1/I) = 40 bits from a CSPRNG
 * (randomBytes; `byte & 31` is unbiased because 256 % 32 === 0). Only HMAC-SHA256(derived key, normalized 8 chars) is stored.
 * 10 minute single-use TTL + per-IP and global attempt ceilings make online guessing infeasible (2^40 space).
 */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
/** Maximum unexpired, unused codes per shop. New codes beyond this are REFUSED (409) rather than silently invalidating older ones. */
export const MAX_OUTSTANDING_PAIRING_CODES = 5;

export function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let body = '';
  for (const b of bytes) body += PAIRING_ALPHABET[b & 31];
  return `PB-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Case/dash/space-insensitive; optional "PB" prefix. Returns the canonical 8-char body or null when malformed. */
export function normalizePairingCode(input: string): string | null {
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === PAIRING_CODE_LENGTH + 2 && s.startsWith('PB')) s = s.slice(2);
  if (s.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of s) if (!PAIRING_ALPHABET.includes(ch)) return null;
  return s;
}

export const hashPairingCode = (config: Pick<Config, 'SESSION_SECRET' | 'STORAGE_URL_SECRET'>, normalized: string): string =>
  hmacHex(deriveSecret(config, 'device-pairing-code'), normalized);

export const pairingCodeInvalid = () => new AppError(400, 'PAIRING_CODE_INVALID', 'This pairing code is invalid or has expired');

/**
 * Client key for pairing throttles: the IP, with IPv6 addresses collapsed to their /64 (an attacker owning a /64 would
 * otherwise rotate through 2^64 "distinct" addresses).
 */
export const pairingClientKey = clientIpKey;

/**
 * Failed-pairing throttle (in memory, per process).
 *  - Per client key: after `perKeyBlock` failures inside the window that client is refused (a guesser is stopped quickly).
 *  - Global: bounds DISTRIBUTED guessing. Each client key contributes at most `perKeyCap` failures to the global count, so
 *    tripping it needs `max / perKeyCap` DISTINCT clients (a botnet), not a couple of cheap IPs. A cheap attacker can no
 *    longer lock every shop out of pairing (regression: see test/security-devices-pairing-dos.test.ts).
 * Failures without a key (legacy callers/tests) are never capped.
 */
export class PairingAttemptCeiling {
  private readonly counted: number[] = [];
  private readonly perKey = new Map<string, number[]>();
  constructor(
    private readonly max = 1000,
    private readonly windowMs = 10 * 60_000,
    private readonly perKeyCap = 5,
    private readonly perKeyBlock = 10
  ) {}
  private prune(now: number) {
    const cutoff = now - this.windowMs;
    while (this.counted.length && this.counted[0]! <= cutoff) this.counted.shift();
    if (this.perKey.size > 5000) {
      for (const [k, v] of this.perKey) {
        const live = v.filter((t) => t > cutoff);
        if (live.length) this.perKey.set(k, live);
        else this.perKey.delete(k);
      }
    }
  }
  private keyFailures(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const live = (this.perKey.get(key) ?? []).filter((t) => t > cutoff);
    if (live.length) this.perKey.set(key, live);
    else this.perKey.delete(key);
    return live;
  }
  /** True when the request must be refused with 429: this client is guessing, or the global distributed ceiling is hit. */
  blocked(now = Date.now(), key?: string): boolean {
    this.prune(now);
    if (key !== undefined && this.keyFailures(key, now).length >= this.perKeyBlock) return true;
    return this.counted.length >= this.max;
  }
  recordFailure(now = Date.now(), key?: string): void {
    this.prune(now);
    if (key === undefined) {
      this.counted.push(now);
      return;
    }
    const live = this.keyFailures(key, now);
    if (live.length < this.perKeyCap) this.counted.push(now);
    live.push(now);
    this.perKey.set(key, live);
  }
}

export type DeviceView = {
  id: string;
  name: string;
  platform: DevicePlatform;
  status: 'ACTIVE' | 'REVOKED';
  presence: 'ONLINE' | 'OFFLINE' | 'REVOKED';
  lastSeenAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
  appVersion: string | null;
};

/** Explicit allow-list: never credentialHash, pushToken, osVersion, shopId. */
export function deviceView(
  d: Pick<ShopDevice, 'id' | 'name' | 'platform' | 'status' | 'lastSeenAt' | 'createdAt' | 'revokedAt' | 'appVersion'>,
  nowMs = Date.now()
): DeviceView {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    status: d.status,
    presence: devicePresence(d, nowMs),
    lastSeenAt: d.lastSeenAt,
    createdAt: d.createdAt,
    revokedAt: d.revokedAt,
    appVersion: d.appVersion
  };
}

export async function createPairingCode(prisma: PrismaClient, config: Config, actor: { shopId: string; userId: string }) {
  const now = new Date();
  const code = generatePairingCode();
  const expiresAt = new Date(now.getTime() + config.DEVICE_PAIRING_TTL_MINUTES * 60_000);
  const row = await prisma.$transaction(async (tx) => {
    // Serialise per shop so concurrent requests cannot all pass the count and exceed the cap (count-then-create race).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'device-pairing:' + actor.shopId}))`;
    const outstanding = await tx.devicePairingCode.count({
      where: { shopId: actor.shopId, usedAt: null, expiresAt: { gt: now } }
    });
    if (outstanding >= MAX_OUTSTANDING_PAIRING_CODES) {
      throw new AppError(409, 'CONFLICT', 'Too many active pairing codes. Use or wait for an existing code to expire.');
    }
    const created = await tx.devicePairingCode.create({
      data: { shopId: actor.shopId, codeHash: hashPairingCode(config, normalizePairingCode(code)!), expiresAt, createdByUserId: actor.userId }
    });
    await audit(tx, {
      shopId: actor.shopId,
      actorUserId: actor.userId,
      actorType: 'SHOP_OWNER',
      action: 'device.pairingCreated',
      targetType: 'DevicePairingCode',
      targetId: created.id
    });
    return created;
  });
  return { code, expiresAt: row.expiresAt };
}

export interface PairInput {
  code: string;
  deviceName: string;
  platform: DevicePlatform;
  appVersion?: string | undefined;
  osVersion?: string | undefined;
}

/** Atomic single-use redemption. Every failure path throws the same PAIRING_CODE_INVALID. Shop comes from the code row only. */
export async function redeemPairingCode(prisma: PrismaClient, config: Config, input: PairInput) {
  const normalized = normalizePairingCode(input.code);
  if (!normalized) throw pairingCodeInvalid();
  const codeHash = hashPairingCode(config, normalized);
  const credential = generateDeviceCredential();
  const now = new Date();
  // Cheap pre-check outside a transaction: guesses and already-used codes never occupy a transaction/connection.
  const existing = await prisma.devicePairingCode.findUnique({ where: { codeHash }, select: { usedAt: true, expiresAt: true } });
  if (!existing || existing.usedAt || existing.expiresAt <= now) throw pairingCodeInvalid();
  return prisma.$transaction(async (tx) => {
    const claim = await tx.devicePairingCode.updateMany({
      where: { codeHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now }
    });
    if (claim.count !== 1) throw pairingCodeInvalid();
    const row = await tx.devicePairingCode.findUniqueOrThrow({ where: { codeHash } });
    const shop = await tx.shop.findUnique({
      where: { id: row.shopId },
      select: { id: true, displayName: true, status: true, subscription: { select: { status: true } } }
    });
    // Suspended / inactive shops get the same generic failure (rolls the claim back; nothing leaks about the code's existence).
    if (!shop || shop.status !== 'ACTIVE' || !subscriptionAllowsIntake(shop.subscription)) throw pairingCodeInvalid();
    const device = await tx.shopDevice.create({
      data: {
        shopId: row.shopId,
        name: input.deviceName,
        platform: input.platform,
        credentialHash: credential.hash,
        appVersion: input.appVersion ?? null,
        osVersion: input.osVersion ?? null
      }
    });
    await tx.devicePairingCode.update({ where: { id: row.id }, data: { usedByDeviceId: device.id } });
    await audit(tx, {
      shopId: row.shopId,
      actorUserId: null,
      actorType: 'SHOP_DEVICE',
      actorDeviceId: device.id,
      action: 'device.paired',
      targetType: 'ShopDevice',
      targetId: device.id,
      metadata: { platform: input.platform }
    });
    return {
      deviceId: device.id,
      deviceCredential: credential.secret,
      shop: { displayName: shop.displayName },
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS
    };
  }, { maxWait: 10_000, timeout: 15_000 });
}

export async function listDevices(prisma: PrismaClient, shopId: string) {
  const rows = await prisma.shopDevice.findMany({ where: { shopId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const now = Date.now();
  return rows.map((d) => deviceView(d, now));
}

const notFoundDevice = () => new AppError(404, 'NOT_FOUND', 'Device not found');

export async function renameDevice(prisma: PrismaClient, actor: { shopId: string; userId: string }, id: string, name: string) {
  return prisma.$transaction(async (tx) => {
    const res = await tx.shopDevice.updateMany({ where: { id, shopId: actor.shopId }, data: { name } });
    if (res.count !== 1) throw notFoundDevice();
    await audit(tx, {
      shopId: actor.shopId,
      actorUserId: actor.userId,
      actorType: 'SHOP_OWNER',
      action: 'device.renamed',
      targetType: 'ShopDevice',
      targetId: id
    });
    return deviceView(await tx.shopDevice.findUniqueOrThrow({ where: { id } }));
  });
}

export async function revokeDevice(prisma: PrismaClient, actor: { shopId: string; userId: string }, id: string) {
  return prisma.$transaction(async (tx) => {
    const res = await tx.shopDevice.updateMany({
      where: { id, shopId: actor.shopId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedByUserId: actor.userId, pushToken: null, pushTokenUpdatedAt: null }
    });
    const device = await tx.shopDevice.findFirst({ where: { id, shopId: actor.shopId } });
    if (!device) throw notFoundDevice();
    if (res.count === 1) {
      await audit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        actorType: 'SHOP_OWNER',
        action: 'device.revoked',
        targetType: 'ShopDevice',
        targetId: id
      });
    }
    return deviceView(device);
  });
}
