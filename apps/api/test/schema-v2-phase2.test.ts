import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boundingBox } from '../src/domain/geo.js';
import { login } from './api-helpers.js';
import { bearerAuth, cookieAuth, DEVICE_A, gtok, headersFor, req, startHarness, type Auth, type Harness } from './helpers/profile-harness.js';

/** Schema-v2 phase 2: discovery profile, geo search, admin verification, paper options, photos. Disposable DB only. */
const KOLKATA = { lat: 22.5726, lng: 88.3639 };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

describe('schema-v2 phase 2: discovery', () => {
  let h: Harness;
  let age = 280;
  let customer: Auth;
  beforeAll(async () => {
    h = await startHarness({ GOOGLE_LOGIN_ENABLED: 'true', CUSTOMER_SIGNUP_ENABLED: 'true' });
  });
  afterAll(async () => h.close());

  const data = (r: LightMyRequestResponse) => r.json().data as Record<string, any>;
  const asAuth = async (email: string) => {
    const s = await login(h.app, email);
    return cookieAuth(s.cookie, s.csrf);
  };

  async function newCustomer(): Promise<Auth> {
    const restricted = await h.app.inject({ method: 'POST', url: '/api/v1/auth', payload: { loginMethod: 'google', firebaseIdToken: gtok(`c${age}@cust.test`, { ago: age-- }), installationId: DEVICE_A, platform: 'android', audience: 'customer' } });
    const created = await req(h.app, bearerAuth(data(restricted).accessToken), 'POST', '/customers/onboarding', { name: 'Cust', client: 'mobile', deviceId: DEVICE_A });
    expect(created.statusCode, created.body).toBe(201);
    return bearerAuth(data(created).accessToken);
  }

  /** Makes shop A discoverable at Kolkata and shop B ~14 km away; both verified, ACTIVE, with rates from the seeded world. */
  async function publish(shopId: string, lat: number, lng: number, over: Record<string, unknown> = {}) {
    await h.prisma.shop.update({ where: { id: shopId }, data: { latitude: lat, longitude: lng, isVerified: true, verifiedAt: new Date(), status: 'ACTIVE', acceptsOrders: true, city: 'Kolkata', ...over } });
  }

  beforeEach(async () => {
    await h.reseed();
    age = 280;
    customer = await newCustomer();
    await publish(h.world.a.shopId, KOLKATA.lat, KOLKATA.lng);
    await publish(h.world.b.shopId, 22.7, 88.4); // ~14.5 km
  });

  const nearby = (q: string, auth: Auth = customer) => req(h.app, auth, 'GET', `/customer/shops/nearby?${q}`);

  describe('geometry', () => {
    it('boundingBox covers the radius and opens longitude near the antimeridian and poles', () => {
      const b = boundingBox(22.57, 88.36, 5);
      expect(b.minLat).toBeLessThan(22.57 - 0.04);
      expect(b.maxLat).toBeGreaterThan(22.57 + 0.04);
      expect(b.minLng).not.toBeNull();
      expect(boundingBox(10, 179.99, 20).minLng).toBeNull();
      expect(boundingBox(89.99, 10, 20).minLng).toBeNull();
    });
  });

  describe('GET /customer/shops/nearby', () => {
    it('orders by distance, applies the radius, and reports distance, rates and open state without owner data', async () => {
      const res = await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20`);
      expect(res.statusCode, res.body).toBe(200);
      const d = data(res);
      expect(d.items.map((s: any) => s.id)).toEqual([h.world.a.shopId, h.world.b.shopId]);
      expect(d).toMatchObject({ page: 1, limit: 20, total: 2 });
      expect(d.items[0].distanceKm).toBe(0);
      expect(d.items[1].distanceKm).toBeGreaterThan(13);
      expect(d.items[1].distanceKm).toBeLessThan(16);
      expect(d.items[0].rates.length).toBeGreaterThan(0);
      expect(d.items[0]).toMatchObject({ isOpen: true });
      const text = res.body;
      for (const secret of ['ownerEmail', 'passwordHash', 'firebase', 'kmsKeyRef', 'subscription', h.world.a.ownerEmail]) expect(text).not.toContain(secret);
      const near = await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}`);
      expect(data(near).items.map((s: any) => s.id)).toEqual([h.world.a.shopId]); // default radius 5 km
    });

    it('validates input: missing/invalid coordinates, radius above 20, bad printingType, unknown keys', async () => {
      for (const q of ['', 'lat=22.5', 'lat=95&lng=88', 'lat=22&lng=181', `lat=22&lng=88&radiusKm=21`, 'lat=22&lng=88&radiusKm=0', 'lat=22&lng=88&printingType=gold', 'lat=22&lng=88&limit=51', 'lat=22&lng=88&x=1', 'lat=abc&lng=1']) {
        const res = await nearby(q);
        expect(res.statusCode, q).toBe(400);
      }
    });

    it('hides unverified, blocked, coordinate-less and far shops; lists closed shops marked as closed', async () => {
      await h.prisma.shop.update({ where: { id: h.world.b.shopId }, data: { isVerified: false } });
      expect(data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20`)).items.map((s: any) => s.id)).toEqual([h.world.a.shopId]);
      await h.prisma.shop.update({ where: { id: h.world.b.shopId }, data: { isVerified: true } });
      await h.prisma.shop.update({ where: { id: h.world.b.shopId }, data: { status: 'SUSPENDED' } });
      expect(data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20`)).total).toBe(1);
      await h.prisma.shop.update({ where: { id: h.world.b.shopId }, data: { status: 'ACTIVE', latitude: null, longitude: null } });
      expect(data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20`)).total).toBe(1);
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { acceptsOrders: false } });
      const closed = data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}`));
      expect(closed.items[0]).toMatchObject({ id: h.world.a.shopId, isOpen: false, acceptsOrders: false });
    });

    it('printingType filters on active rates and paginates with an honest total', async () => {
      await h.prisma.pricingRule.updateMany({ where: { shopId: h.world.b.shopId, colourMode: 'colour' }, data: { active: false } });
      const colored = data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20&printingType=colored`));
      expect(colored.items.map((s: any) => s.id)).toEqual([h.world.a.shopId]);
      const bw = data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20&printingType=blackWhite`));
      expect(bw.total).toBe(2);
      const p2 = data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20&limit=1&page=2`));
      expect(p2).toMatchObject({ page: 2, limit: 1, total: 2 });
      expect(p2.items.map((s: any) => s.id)).toEqual([h.world.b.shopId]);
      const beyond = data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20&limit=1&page=5`));
      expect(beyond).toMatchObject({ items: [], total: 2 });
    });

    it('is customer-only', async () => {
      const owner = await asAuth(h.world.a.ownerEmail);
      expect((await nearby('lat=22&lng=88', owner)).statusCode).toBe(403);
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/customer/shops/nearby?lat=22&lng=88' })).statusCode).toBe(401);
    });
  });

  describe('GET /customer/shops/:shopId', () => {
    it('returns the card with location for a verified shop and 404 for anything else', async () => {
      const ok = await req(h.app, customer, 'GET', `/customer/shops/${h.world.a.shopId}`);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(data(ok)).toMatchObject({ id: h.world.a.shopId, location: { latitude: KOLKATA.lat, longitude: KOLKATA.lng }, paperTypes: ['normal'] });
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { isVerified: false } });
      expect((await req(h.app, customer, 'GET', `/customer/shops/${h.world.a.shopId}`)).statusCode).toBe(404);
      expect((await req(h.app, customer, 'GET', '/customer/shops/does-not-exist')).statusCode).toBe(404);
    });
  });

  describe('owner shop profile (/shops/{shopId})', () => {
    it('updates profile and location, and the shop becomes findable at the new point', async () => {
      const owner = await asAuth(h.world.a.ownerEmail);
      const res = await req(h.app, owner, 'PATCH', `/shops/${h.world.a.shopId}`, { phoneNumber: '+919999999998', addressLine1: '5 Market Road', city: 'Howrah', state: 'WB', pincode: '711101', latitude: 22.59, longitude: 88.31 });
      expect(res.statusCode, res.body).toBe(200);
      expect(data(res)).toMatchObject({ city: 'Howrah', phoneNumber: '+919999999998', location: { latitude: 22.59, longitude: 88.31 } });
      const found = data(await nearby('lat=22.59&lng=88.31&radiusKm=1'));
      expect(found.items.map((s: any) => s.id)).toEqual([h.world.a.shopId]);
    });

    it('rejects admin-only fields, partial coordinates and bad values with 400', async () => {
      const owner = await asAuth(h.world.a.ownerEmail);
      for (const body of [{}, { isVerified: true }, { status: 'ACTIVE' }, { isActive: true }, { latitude: 10 }, { latitude: 99, longitude: 1 }, { phoneNumber: '12345' }, { pincode: '1' }, { slug: 'x' }]) {
        expect((await req(h.app, owner, 'PATCH', `/shops/${h.world.a.shopId}`, body)).statusCode, JSON.stringify(body)).toBe(400);
      }
      const row = await h.prisma.shop.findUniqueOrThrow({ where: { id: h.world.a.shopId } });
      expect(row.isVerified).toBe(true);
    });

    it('never lets one owner read or change another owner\'s shop (404, nothing written)', async () => {
      const ownerA = await asAuth(h.world.a.ownerEmail);
      expect((await req(h.app, ownerA, 'GET', `/shops/${h.world.b.shopId}`)).statusCode).toBe(404);
      expect((await req(h.app, ownerA, 'PATCH', `/shops/${h.world.b.shopId}`, { city: 'Hacked' })).statusCode).toBe(404);
      expect((await req(h.app, ownerA, 'PUT', `/shops/${h.world.b.shopId}/paper-options`, { paperSizes: [], paperTypes: [] })).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'POST', url: `/api/v1/shops/${h.world.b.shopId}/images`, headers: { ...headersFor(ownerA), 'content-type': 'image/png' }, payload: PNG })).statusCode).toBe(404);
      expect((await h.prisma.shop.findUniqueOrThrow({ where: { id: h.world.b.shopId } })).city).toBe('Kolkata');
      expect((await customerForbidden()).statusCode).toBe(403);
    });
    const customerForbidden = () => req(h.app, customer, 'GET', `/shops/${h.world.a.shopId}`);

    it('opening needs an active shop and at least one rate; closing is always allowed', async () => {
      const owner = await asAuth(h.world.a.ownerEmail);
      expect(data(await req(h.app, owner, 'PATCH', `/shops/${h.world.a.shopId}`, { isOpen: false })).isOpen).toBe(false);
      await h.prisma.pricingRule.updateMany({ where: { shopId: h.world.a.shopId }, data: { active: false } });
      const noRate = await req(h.app, owner, 'PATCH', `/shops/${h.world.a.shopId}`, { isOpen: true });
      expect(noRate.statusCode).toBe(422);
      expect(noRate.json().error.code).toBe('RATE_NOT_SET');
      await h.prisma.pricingRule.updateMany({ where: { shopId: h.world.a.shopId }, data: { active: true } });
      expect(data(await req(h.app, owner, 'PATCH', `/shops/${h.world.a.shopId}`, { isOpen: true })).isOpen).toBe(true);
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'PILOT' } });
      expect((await req(h.app, owner, 'PATCH', `/shops/${h.world.a.shopId}`, { isOpen: true })).json().error.code).toBe('SHOP_NOT_ACTIVE');
    });
  });

  describe('paper options', () => {
    it('only advertises priced sizes and plain paper, replaces atomically, and is visible to customers', async () => {
      const owner = await asAuth(h.world.a.ownerEmail);
      const url = `/shops/${h.world.a.shopId}/paper-options`;
      expect((await req(h.app, owner, 'PUT', url, { paperSizes: ['A3'], paperTypes: [] })).json().error.code).toBe('UNSUPPORTED_PAPER');
      expect((await req(h.app, owner, 'PUT', url, { paperSizes: ['A4'], paperTypes: ['glossy'] })).json().error.code).toBe('UNSUPPORTED_PAPER');
      expect((await req(h.app, owner, 'PUT', url, { paperSizes: ['A4', 'A4'], paperTypes: [] })).statusCode).toBe(400);
      const ok = await req(h.app, owner, 'PUT', url, { paperSizes: ['A4'], paperTypes: ['normal'] });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(data(ok)).toMatchObject({ paperSizes: ['A4'], paperTypes: ['normal'] });
      const card = data(await req(h.app, customer, 'GET', `/customer/shops/${h.world.a.shopId}`));
      expect(card).toMatchObject({ paperSizes: ['A4'], paperTypes: ['normal'] });
      await req(h.app, owner, 'PUT', url, { paperSizes: [], paperTypes: [] });
      expect(await h.prisma.shopPaperOption.count({ where: { shopId: h.world.a.shopId } })).toBe(0);
    });
  });

  describe('shop photos', () => {
    const upload = (auth: Auth, shopId: string, body: Buffer, type = 'image/png') =>
      h.app.inject({ method: 'POST', url: `/api/v1/shops/${shopId}/images`, headers: { ...headersFor(auth), 'content-type': type }, payload: body });

    it('stores private objects after a magic-byte check, serves them only through the API, and deletes them', async () => {
      const owner = await asAuth(h.world.a.ownerEmail);
      const up = await upload(owner, h.world.a.shopId, PNG);
      expect(up.statusCode, up.body).toBe(201);
      const image = data(up);
      const row = await h.prisma.shopImage.findUniqueOrThrow({ where: { id: image.id } });
      expect(row.imageKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(row.shopId).toBe(h.world.a.shopId);
      expect(JSON.stringify(image)).not.toContain(row.imageKey);
      const served = await h.app.inject({ method: 'GET', url: `/api/v1/customer/shops/${h.world.a.shopId}/images/${image.id}`, headers: headersFor(customer) });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toBe('image/png');
      expect(served.rawPayload.equals(PNG)).toBe(true);
      expect((await h.app.inject({ method: 'GET', url: `/api/v1/customer/shops/${h.world.a.shopId}/images/${image.id}` })).statusCode).toBe(401);
      const card = data(await req(h.app, customer, 'GET', `/customer/shops/${h.world.a.shopId}`));
      expect(card.images).toEqual([{ id: image.id, url: `/customer/shops/${h.world.a.shopId}/images/${image.id}`, sortOrder: 0 }]);
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { isVerified: false } });
      expect((await h.app.inject({ method: 'GET', url: `/api/v1/customer/shops/${h.world.a.shopId}/images/${image.id}`, headers: headersFor(customer) })).statusCode).toBe(404);
      expect((await req(h.app, owner, 'DELETE', `/shops/${h.world.a.shopId}/images/${image.id}`)).statusCode).toBe(204);
      expect(await h.prisma.shopImage.count({ where: { shopId: h.world.a.shopId } })).toBe(0);
      expect(await h.world && (await h.app.inject({ method: 'GET', url: `/api/v1/shops/${h.world.a.shopId}/images/${image.id}`, headers: headersFor(owner) })).statusCode).toBe(404);
    });

    it('rejects non-images with a lying content type, oversize bodies, and the 9th photo', async () => {
      const owner = await asAuth(h.world.a.ownerEmail);
      expect((await upload(owner, h.world.a.shopId, Buffer.from('<html>not an image</html>'))).statusCode).toBe(400);
      expect((await upload(owner, h.world.a.shopId, Buffer.from('GIF89a....'), 'image/png')).statusCode).toBe(400);
      expect((await upload(owner, h.world.a.shopId, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).statusCode).toBe(413);
      expect((await h.app.inject({ method: 'POST', url: `/api/v1/shops/${h.world.a.shopId}/images`, headers: { ...headersFor(owner), 'content-type': 'application/pdf' }, payload: PNG })).statusCode).toBeGreaterThanOrEqual(400);
      for (let i = 0; i < 8; i++) expect((await upload(owner, h.world.a.shopId, i % 2 ? JPEG : PNG, i % 2 ? 'image/jpeg' : 'image/png')).statusCode).toBe(201);
      expect((await upload(owner, h.world.a.shopId, PNG)).statusCode).toBe(409);
      expect(await h.prisma.shopImage.count({ where: { shopId: h.world.a.shopId } })).toBe(8);
    });
  });

  describe('admin verification and blocking', () => {
    it('verify/unverify toggles discovery and writes an audit entry with before and after', async () => {
      const admin = await asAuth(h.world.adminEmail);
      await h.prisma.shop.update({ where: { id: h.world.b.shopId }, data: { isVerified: false, verifiedAt: null } });
      const list = await req(h.app, admin, 'GET', '/admin/shops?isVerified=false');
      expect(data(list).items.map((s: any) => s.id)).toEqual([h.world.b.shopId]);
      const v = await req(h.app, admin, 'PATCH', `/admin/shops/${h.world.b.shopId}/verify`, { isVerified: true });
      expect(v.statusCode, v.body).toBe(200);
      expect(data(v)).toMatchObject({ id: h.world.b.shopId, isVerified: true });
      expect(data(v).verifiedBy).toBeTruthy();
      expect(data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20`)).total).toBe(2);
      const log = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'shop.verify', targetId: h.world.b.shopId } });
      expect(log.metadata).toEqual({ before: { isVerified: false }, after: { isVerified: true } });
      await req(h.app, admin, 'PATCH', `/admin/shops/${h.world.b.shopId}/verify`, { isVerified: false });
      expect(data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20`)).total).toBe(1);
      expect(await h.prisma.auditLog.count({ where: { action: 'shop.unverify' } })).toBe(1);
    });

    it('block suspends the shop, ends its sessions and hides it; unblock restores only SUSPENDED shops', async () => {
      const admin = await asAuth(h.world.adminEmail);
      const owner = await asAuth(h.world.b.ownerEmail);
      const b = await req(h.app, admin, 'PATCH', `/admin/shops/${h.world.b.shopId}/block`, { isActive: false });
      expect(data(b)).toMatchObject({ isActive: false, status: 'SUSPENDED' });
      expect((await req(h.app, owner, 'GET', '/shop/settings')).statusCode).toBe(401);
      expect(data(await nearby(`lat=${KOLKATA.lat}&lng=${KOLKATA.lng}&radiusKm=20`)).total).toBe(1);
      const u = await req(h.app, admin, 'PATCH', `/admin/shops/${h.world.b.shopId}/block`, { isActive: true });
      expect(data(u)).toMatchObject({ isActive: true, status: 'ACTIVE' });
      await h.prisma.shop.update({ where: { id: h.world.a.shopId }, data: { status: 'PILOT' } });
      expect(data(await req(h.app, admin, 'PATCH', `/admin/shops/${h.world.a.shopId}/block`, { isActive: true })).status).toBe('PILOT');
      expect((await h.prisma.auditLog.findMany({ where: { action: { in: ['shop.block', 'shop.unblock'] } } })).length).toBe(2);
    });

    it('is admin-only and validates input', async () => {
      const owner = await asAuth(h.world.a.ownerEmail);
      expect((await req(h.app, owner, 'PATCH', `/admin/shops/${h.world.a.shopId}/verify`, { isVerified: true })).statusCode).toBe(403);
      expect((await req(h.app, customer, 'PATCH', `/admin/shops/${h.world.a.shopId}/block`, { isActive: false })).statusCode).toBe(403);
      const admin = await asAuth(h.world.adminEmail);
      expect((await req(h.app, admin, 'PATCH', `/admin/shops/${h.world.a.shopId}/verify`, { isVerified: 'yes' })).statusCode).toBe(400);
      expect((await req(h.app, admin, 'PATCH', `/admin/shops/${h.world.a.shopId}/verify`, { isVerified: true, status: 'ACTIVE' })).statusCode).toBe(400);
      expect((await req(h.app, admin, 'PATCH', '/admin/shops/nonexistent-id/verify', { isVerified: true })).statusCode).toBe(404);
    });
  });
});
