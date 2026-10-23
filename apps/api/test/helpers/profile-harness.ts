import { Role, ShopStatus, type PrismaClient } from '@prisma/client';
import { afterAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth.js';
import { mintEmulatorToken } from '../../src/firebase/test-token.js';
import type { PhoneTokenVerifier } from '../../src/firebase/verifier.js';
import type { PushMessage, PushResult, PushSender } from '../../src/notifications/fcm.js';
import { PASSWORD, seedWorld, testConfig, type World } from '../api-helpers.js';
import { testPrisma } from './db.js';
import { startFakeAuthEmulator, type FakeAuthEmulator } from './fake-auth-emulator.js';

/**
 * Shared harness for the profile / onboarding API tests. The REAL firebase-admin verifies emulator-style (unsigned) tokens:
 * claims, audience, issuer and expiry are checked, signatures are NOT (that needs Google's certificates).
 */
export const PROJECT = 'printout-test-project';
export const PHONES = {
  A: '+919876543210',
  B: '+919123456780',
  NEW: '+919555500001',
  NEW2: '+919555500002',
  NOSHOP: '+919555500003',
  ADMIN: '+919555500004'
} as const;
export const WEB_ORIGIN = 'http://localhost:5173';
const nowSec = () => Math.floor(Date.now() / 1000);

export type TokenExtra = Partial<Parameters<typeof mintEmulatorToken>[0]>;
/** Token whose OTP was verified `ago` seconds ago. The uid is derived from the phone, so one phone = one Firebase identity. */
export const tok = (phone: string | null, ago = 5, extra: TokenExtra = {}) =>
  mintEmulatorToken({ projectId: PROJECT, uid: `uid-${phone ?? 'none'}`, phone, authTime: nowSec() - ago, ...extra });

export interface GoogleTokenOptions {
  uid?: string;
  /** Seconds ago the user authenticated with Google (smaller = newer; replay protection needs strictly newer each time). */
  ago?: number;
  /** email_verified claim. `undefined` explicitly omits it. Default true. */
  emailVerified?: boolean | undefined;
  provider?: string;
  projectId?: string;
  exp?: number;
  aud?: string;
  iss?: string;
  /** Omit the email claim entirely. */
  noEmail?: boolean;
}

/**
 * Unsigned emulator-style Firebase ID token for a Google sign-in (sign_in_provider google.com, email + email_verified).
 * Minted here so the Google tests do not depend on src/firebase/test-token.ts; the format is identical (alg "none").
 */
export function gtok(email: string, o: GoogleTokenOptions = {}): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = nowSec();
  const authTime = now - (o.ago ?? 5);
  const uid = o.uid ?? `guid-${email.toLowerCase()}`;
  const project = o.projectId ?? PROJECT;
  const payload: Record<string, unknown> = {
    iss: o.iss ?? `https://securetoken.google.com/${project}`,
    aud: o.aud ?? project,
    auth_time: authTime,
    user_id: uid,
    sub: uid,
    iat: Math.min(authTime, now),
    exp: o.exp ?? authTime + 3600,
    firebase: { identities: { 'google.com': [uid], ...(o.noEmail ? {} : { email: [email] }) }, sign_in_provider: o.provider ?? 'google.com' }
  };
  if (!o.noEmail) payload.email = email;
  if (!('emailVerified' in o)) payload.email_verified = true;
  else if (o.emailVerified !== undefined) payload.email_verified = o.emailVerified;
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
}

export const BASE_ENV = { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_CHECK_REVOKED: 'false' };

export interface Harness {
  app: FastifyInstance;
  prisma: PrismaClient;
  emulator: FakeAuthEmulator;
  world: World;
  reseed(): Promise<World>;
  close(): Promise<void>;
}

/** Starts the fake Firebase emulator, builds the app (self-onboarding ON by default) and seeds the two-shop world. */
export async function startHarness(
  over: Record<string, string> = {},
  phoneVerifier?: PhoneTokenVerifier | null,
  extra: { pushSender?: PushSender | null } = {}
): Promise<Harness> {
  const emulator = await sharedEmulator();
  const prisma = testPrisma();
  // A value of '__unset__' leaves the variable out entirely (to test the compiled-in default).
  const env = Object.fromEntries(Object.entries({ ...BASE_ENV, SHOP_SELF_ONBOARDING_ENABLED: 'true', ...over }).filter(([, v]) => v !== '__unset__'));
  const { app } = createApp({
    config: testConfig(env),
    prisma,
    ...(phoneVerifier !== undefined ? { phoneVerifier } : {}),
    ...(extra.pushSender !== undefined ? { pushSender: extra.pushSender } : {})
  });
  await app.ready();
  const h: Harness = {
    app,
    prisma,
    emulator,
    world: await seedWorld(prisma),
    async reseed() {
      emulator.disabled.clear();
      h.world = await seedWorld(prisma);
      return h.world;
    },
    async close() {
      // The emulator is shared by every harness of this test file (see sharedEmulator) and closed once, after the last test.
      await app.close();
    }
  };
  return h;
}

/**
 * ONE fake Firebase emulator per test file. firebase-admin caches its app (and therefore FIREBASE_AUTH_EMULATOR_HOST) on first use, so a
 * second harness pointing at a fresh emulator would silently keep talking to the first, already-closed one and every verification would
 * come back "unavailable" (503) - which looks like a refusal and hides real assertions.
 */
let emulatorOnce: Promise<FakeAuthEmulator> | null = null;
function sharedEmulator(): Promise<FakeAuthEmulator> {
  emulatorOnce ??= startFakeAuthEmulator().then((e) => {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = e.host;
    return e;
  });
  return emulatorOnce;
}
afterAll(async () => {
  if (emulatorOnce) await (await emulatorOnce).close();
  emulatorOnce = null;
});

// ---- auth modes -------------------------------------------------------------------------------------------------------------

export type Auth =
  | null
  | { kind: 'cookie'; cookie: string; csrf?: string | undefined }
  | { kind: 'bearer'; token: string }
  | { kind: 'grant-cookie'; cookie: string };

export const cookieAuth = (cookie: string, csrf?: string): Auth => ({ kind: 'cookie', cookie, csrf });
export const bearerAuth = (token: string): Auth => ({ kind: 'bearer', token });

export function headersFor(auth: Auth): Record<string, string> {
  if (!auth) return {};
  if (auth.kind === 'bearer') return { authorization: `Bearer ${auth.token}` };
  if (auth.kind === 'grant-cookie') return { cookie: auth.cookie };
  return { cookie: auth.cookie, ...(auth.csrf ? { 'x-csrf-token': auth.csrf } : {}) };
}

export function req(app: FastifyInstance, auth: Auth, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...headersFor(auth), ...extraHeaders },
    ...(body === undefined ? {} : { payload: body as object })
  });
}

export const DEVICE_A = 'test-device-A-0000000001';
export const DEVICE_B = 'test-device-B-0000000002';

/** Mobile exchanges carry a deviceId (it binds the refresh-token family to one installation). Web ones do not. */
export const exchange = (app: FastifyInstance, idToken: unknown, client?: 'web' | 'mobile', headers: Record<string, string> = {}, deviceId?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/firebase/exchange',
    payload: { idToken, ...(client ? { client } : {}), ...(client === 'mobile' ? { deviceId: deviceId ?? DEVICE_A } : {}) } as object,
    headers
  });

/** Mobile session pieces from an exchange / refresh response. Tolerates the session being at data.session or data. */
export function mobileSessionOf(res: LightMyRequestResponse) {
  // Flat contract: accessToken / refreshToken / tokenType / expiresIn / refreshTokenExpiresIn at the top of data (older nested shape tolerated).
  const d = res.json().data;
  const s = (d.session ?? d) as Record<string, any>;
  const at = (iso: unknown, secs: unknown) => (typeof iso === 'string' ? iso : typeof secs === 'number' ? new Date(Date.now() + secs * 1000).toISOString() : (undefined as unknown as string));
  return {
    accessToken: s.accessToken as string,
    accessTokenExpiresAt: at(s.accessTokenExpiresAt, s.expiresIn),
    refreshToken: s.refreshToken as string,
    refreshTokenExpiresAt: at(s.refreshTokenExpiresAt, s.refreshTokenExpiresIn),
    transport: (s.transport ?? (s.tokenType ? String(s.tokenType).toLowerCase() : undefined)) as string
  };
}

export const refresh = (app: FastifyInstance, refreshToken: unknown, deviceId: unknown = DEVICE_A, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken, deviceId } as object, headers });

export const cookieOf = (res: LightMyRequestResponse, name: string) => res.cookies.find((c) => c.name === name);

/** Normalises the exchange response: web -> session cookie + csrf, mobile -> bearer token. Throws if no session was issued. */
export function sessionAuthFrom(res: LightMyRequestResponse): Auth {
  const data = res.json().data;
  if (!data) throw new Error(`no session issued (error response): ${res.statusCode} ${res.body.slice(0, 300)}`);
  const c = cookieOf(res, 'printout_session');
  if (c) return cookieAuth(`printout_session=${c.value}`, data.csrfToken);
  const token = data.accessToken ?? data.session?.accessToken ?? data.session?.token;
  if (typeof token === 'string') return bearerAuth(token);
  throw new Error(`no session issued: ${res.statusCode} ${res.body}`);
}

/** Restricted onboarding grant from a restricted exchange: web -> cookie, mobile -> token (tolerates either field name). */
export function grantAuthFrom(res: LightMyRequestResponse): Auth {
  const c = cookieOf(res, 'printout_onboarding');
  if (c) return { kind: 'grant-cookie', cookie: `printout_onboarding=${c.value}` };
  const data = res.json().data;
  const token = data.accessToken ?? data.onboarding?.token ?? data.onboardingToken ?? data.session?.token;
  if (typeof token === 'string') return bearerAuth(token);
  throw new Error(`no onboarding grant issued: ${res.statusCode} ${res.body}`);
}

// ---- response normalisers (the contract allows /users/me to be the profile itself or {user, shop, nextStep}) -------------------

export const dataOf = (res: LightMyRequestResponse) => res.json().data as Record<string, any>;
export const userOf = (res: LightMyRequestResponse): Record<string, any> => {
  const d = dataOf(res);
  return d.user && typeof d.user === 'object' ? d.user : d;
};
export const shopOf = (res: LightMyRequestResponse): Record<string, any> | null => {
  const d = dataOf(res);
  if ('shop' in d && (d.shop === null || typeof d.shop === 'object')) return d.shop;
  return d;
};
export const nextStepOf = (res: LightMyRequestResponse): string | undefined => {
  const d = dataOf(res);
  return d.nextStep ?? d.user?.nextStep ?? d.shop?.onboardingStatus;
};

// ---- fixtures --------------------------------------------------------------------------------------------------------------

export const USER_PROFILE_KEYS = [
  'id', 'role', 'name', 'email', 'phoneNumber', 'loginMethods', 'emailVerified', 'phoneVerified', 'createdAt', 'updatedAt', 'lastLoginAt'
];
export const SHOP_PROFILE_KEYS = [
  'shopName', 'showQr', 'qrCodeUrl', 'address', 'location', 'status', 'plan', 'rateInfo', 'services', 'payment', 'rating', 'images',
  'referral', 'registeredBy', 'onboardingStatus'
];
/** Fields that must never reach a client. */
export const FORBIDDEN_KEYS = ['firebaseUid', 'firebase_uid', 'fcmToken', 'fcmTokens', 'passwordHash', 'tokenHash', 'secretEnc', 'kmsKeyRef'];

export function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
  return into;
}

/** Fills in what makes a seeded shop a complete, live, QR-ready shop (address set, ACTIVE). */
export async function makeShopReady(prisma: PrismaClient, shopId: string, over: { address?: string | null; status?: ShopStatus } = {}) {
  await prisma.shop.update({
    where: { id: shopId },
    data: { address: over.address === undefined ? '12 MG Road, Bengaluru' : over.address, status: over.status ?? ShopStatus.ACTIVE }
  });
}

/** Links `phone` to an existing user straight in the database (the API path needs a fresh OTP; this is for fixtures). */
export async function linkPhoneDirect(prisma: PrismaClient, userId: string, phone: string, uid = `uid-${phone}`) {
  return prisma.userPhoneIdentity.create({
    data: { userId, firebaseUid: uid, phoneE164: phone, linkedAt: new Date(), lastSignInAt: new Date() }
  });
}

export async function userByEmail(prisma: PrismaClient, email: string) {
  return prisma.user.findUniqueOrThrow({ where: { email } });
}

/** A SHOP_OWNER with NO shop (e.g. the shop row was removed: User.shopId is SetNull). */
export async function makeShoplessOwner(prisma: PrismaClient, email = 'noshop@x.test', name = 'No Shop Owner') {
  return prisma.user.create({ data: { email, displayName: name, passwordHash: await hashPassword(PASSWORD), role: Role.SHOP_OWNER } });
}

/** Records every push and answers per token; never touches the network. */
export class FakePushSender implements PushSender {
  calls: Array<{ tokens: string[]; message: PushMessage }> = [];
  /** token -> FCM error code to answer with (anything not listed succeeds). */
  failWith = new Map<string, string>();
  throwAll = false;
  async send(tokens: string[], message: PushMessage): Promise<PushResult[]> {
    this.calls.push({ tokens: [...tokens], message: { ...message } });
    if (this.throwAll) throw new Error('simulated FCM outage');
    return tokens.map((t) => (this.failWith.has(t) ? { ok: false, code: this.failWith.get(t)! } : { ok: true }));
  }
  get allTokens() {
    return this.calls.flatMap((c) => c.tokens);
  }
  reset() {
    this.calls = [];
    this.failWith.clear();
    this.throwAll = false;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ONBOARDING_BODY = {
  ownerName: 'Asha Verma',
  email: 'asha@newshop.test',
  shopName: 'Asha Prints',
  address: '45 Park Street, Kolkata',
  pincode: '700016'
} as const;
