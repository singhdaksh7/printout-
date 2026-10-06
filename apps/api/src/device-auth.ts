import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DevicePlatform } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { subscriptionAllowsIntake } from './domain/eligibility.js';
import { AppError } from './errors.js';
import type { AppContext } from './routes/context.js';

/**
 * Device authentication (Phase 2). Completely separate from the cookie/CSRF shop-owner session:
 *   Authorization: Bearer pbd_<43 url-safe chars>      (256-bit random credential, issued ONCE at pairing)
 * Only sha256(credential) is stored (ShopDevice.credentialHash). The credential is never logged (the request logger redacts
 * req.headers.authorization) and never returned again. The device row resolves exactly one shop: request bodies never
 * supply a shop id. A revoked device is rejected on its very next request (the row is read on every request).
 *
 * Rotation (future): issue a new credential, store its hash + bump credentialVersion, return it once.
 */
export const DEVICE_CREDENTIAL_PREFIX = 'pbd_';
const MAX_CREDENTIAL_LENGTH = 100;

export interface DeviceContext {
  deviceId: string;
  shopId: string;
  platform: DevicePlatform;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    device?: DeviceContext;
  }
}

export const hashDeviceCredential = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

export function generateDeviceCredential(): { secret: string; hash: string } {
  const secret = `${DEVICE_CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { secret, hash: hashDeviceCredential(secret) };
}

const unauthorized = () => new AppError(401, 'UNAUTHORIZED', 'Device authentication required');

/** preHandler for every device-authenticated route. Sets request.device. */
export function deviceGuard(ctx: AppContext) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw unauthorized();
    const raw = header.slice('Bearer '.length).trim();
    if (!raw.startsWith(DEVICE_CREDENTIAL_PREFIX) || raw.length > MAX_CREDENTIAL_LENGTH) throw unauthorized();
    const hash = hashDeviceCredential(raw);
    const device = await ctx.prisma.shopDevice.findUnique({
      where: { credentialHash: hash },
      include: { shop: { select: { status: true, subscription: { select: { status: true } } } } }
    });
    if (!device) throw unauthorized();
    const a = Buffer.from(device.credentialHash, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized();
    if (device.status !== 'ACTIVE' || device.revokedAt) throw new AppError(401, 'DEVICE_REVOKED', 'This device has been disconnected');
    if (device.shop.status === 'SUSPENDED') throw new AppError(403, 'SHOP_SUSPENDED', 'This shop is suspended');
    // A paired device must not bypass the shop's subscription: same rule as public intake (no subscription row or ACTIVE).
    if (!subscriptionAllowsIntake(device.shop.subscription)) {
      throw new AppError(403, 'SUBSCRIPTION_INACTIVE', "This shop's subscription is not active");
    }
    request.device = { deviceId: device.id, shopId: device.shopId, platform: device.platform, name: device.name };
  };
}

/** The authenticated device. The ONLY tenant source for device routes. */
export function deviceOf(request: FastifyRequest): DeviceContext {
  if (!request.device) throw unauthorized();
  return request.device;
}
