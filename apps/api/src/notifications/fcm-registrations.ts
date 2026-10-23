import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { tokenHash } from '../auth.js';
import type { Config } from '../config.js';

/**
 * FCM registration storage. The token is a device push credential: stored ONLY encrypted at rest (AES-256-GCM) with a SHA-256 lookup
 * hash, never returned by any endpoint, never logged or audited. Every query here is scoped by the owning user id.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export const MAX_ACTIVE_REGISTRATIONS_PER_USER = 20;

/** 32-byte key: FCM_TOKEN_ENCRYPTION_KEY, or a purpose-bound HKDF of SESSION_SECRET (label printout:fcm:v1). */
export function fcmKey(config: Pick<Config, 'FCM_TOKEN_ENCRYPTION_KEY' | 'SESSION_SECRET'>): Buffer {
  if (config.FCM_TOKEN_ENCRYPTION_KEY) return Buffer.from(config.FCM_TOKEN_ENCRYPTION_KEY, 'base64');
  return Buffer.from(hkdfSync('sha256', config.SESSION_SECRET, 'printout', 'printout:fcm:v1', 32));
}

export function encryptFcmToken(key: Buffer, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Returns null when the value is empty/tampered or sealed with another key (the registration is then useless and gets revoked). */
export function decryptFcmToken(key: Buffer, sealed: string): string | null {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const hashFcmToken = tokenHash;

/** Revokes registrations: disabled, secret material removed, hash freed (so the same token can be registered again by its new holder). */
async function revokeWhere(db: Db, where: Prisma.Sql): Promise<number> {
  return db.$executeRaw`UPDATE "FcmRegistration" SET "enabled" = false, "revokedAt" = now(), "tokenCipher" = '', "tokenHash" = 'revoked:' || "id", "updatedAt" = now() WHERE "revokedAt" IS NULL AND ${where}`;
}

export const revokeInstallation = (db: Db, userId: string, installationId: string) => revokeWhere(db, Prisma.sql`"userId" = ${userId} AND "installationId" = ${installationId}`);
export const revokeUserToken = (db: Db, userId: string, token: string) => revokeWhere(db, Prisma.sql`"userId" = ${userId} AND "tokenHash" = ${hashFcmToken(token)}`);
export const revokeAllForUser = (db: Db, userId: string) => revokeWhere(db, Prisma.sql`"userId" = ${userId}`);
export const revokeById = (db: Db, id: string) => revokeWhere(db, Prisma.sql`"id" = ${id}`);

export interface RegisterInput {
  userId: string;
  shopId: string | null;
  installationId: string;
  platform: 'android' | 'ios' | 'web';
  token: string;
}

/** Idempotent upsert for (user, installation). Returns whether the token was taken over from another holder, and how many old ones were evicted. */
export async function registerToken(db: PrismaClient, key: Buffer, input: RegisterInput): Promise<{ moved: boolean; evicted: number }> {
  const hash = hashFcmToken(input.token);
  const sealed = encryptFcmToken(key, input.token);
  return db.$transaction(async (tx) => {
    // The same token under another account/installation = the device changed hands: the older registration is revoked, never shared.
    const holder = await tx.fcmRegistration.findUnique({ where: { tokenHash: hash }, select: { id: true, userId: true, installationId: true } });
    const moved = !!holder && (holder.userId !== input.userId || holder.installationId !== input.installationId);
    if (holder && moved) await revokeById(tx, holder.id);
    const now = new Date();
    await tx.fcmRegistration.upsert({
      where: { userId_installationId: { userId: input.userId, installationId: input.installationId } },
      create: { userId: input.userId, shopId: input.shopId, installationId: input.installationId, platform: input.platform, tokenCipher: sealed, tokenHash: hash, lastRegisteredAt: now },
      update: { shopId: input.shopId, platform: input.platform, tokenCipher: sealed, tokenHash: hash, enabled: true, revokedAt: null, failureCount: 0, lastRegisteredAt: now }
    });
    const surplus = await tx.fcmRegistration.findMany({
      where: { userId: input.userId, enabled: true, revokedAt: null },
      orderBy: [{ lastRegisteredAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
      skip: MAX_ACTIVE_REGISTRATIONS_PER_USER
    });
    for (const s of surplus) await revokeById(tx, s.id);
    return { moved, evicted: surplus.length };
  });
}

/** Housekeeping: revoked rows older than 30 days and registrations the app stopped refreshing. */
export async function sweepFcm(prisma: PrismaClient, staleDays: number, now = new Date()): Promise<{ deleted: number }> {
  const revokedCutoff = new Date(now.getTime() - 30 * 86_400_000);
  const staleCutoff = new Date(now.getTime() - staleDays * 86_400_000);
  const res = await prisma.fcmRegistration.deleteMany({ where: { OR: [{ revokedAt: { lt: revokedCutoff } }, { lastRegisteredAt: { lt: staleCutoff } }] } });
  return { deleted: res.count };
}
