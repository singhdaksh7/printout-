import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, call, login, newOrder, PASSWORD, seedWorld, type Session, type World } from './api-helpers.js';

describe('platform admin API', () => {
  const { app, prisma } = buildApp();
  let world: World;
  let admin: Session;
  let owner: Session;
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedWorld(prisma);
    admin = await login(app, world.adminEmail);
    owner = await login(app, world.a.ownerEmail);
  });

  const adminRoutes: Array<['GET' | 'POST' | 'PUT', string, unknown]> = [
    ['GET', '/admin/dashboard', undefined],
    ['GET', '/admin/orders', undefined],
    ['GET', '/admin/shops', undefined],
    ['POST', '/admin/shops', { slug: 'new-shop', displayName: 'N', owner: { email: 'n@x.test', displayName: 'N', password: 'a-long-password-1' } }],
    ['GET', '/admin/shops/abcdefghij', undefined],
    ['PUT', '/admin/shops/abcdefghij', { status: 'SUSPENDED' }],
    ['GET', '/admin/plans', undefined],
    ['PUT', '/admin/plans/abcdefghij', { active: false }],
    ['GET', '/admin/subscriptions', undefined],
    ['PUT', '/admin/subscriptions/abcdefghij', { status: 'SUSPENDED' }],
    ['GET', '/admin/audit-logs', undefined]
  ];

  it('RBAC: unauthenticated 401, shop owner 403 on every admin route', async () => {
    for (const [method, url, body] of adminRoutes) {
      expect((await call(app, null, method, url, body)).statusCode, `anon ${method} ${url}`).toBe(401);
      expect((await call(app, owner, method, url, body)).statusCode, `owner ${method} ${url}`).toBe(403);
    }
  });

  it('CSRF is required on admin mutations', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/v1/admin/shops/${world.a.shopId}`, headers: { cookie: admin.cookie }, payload: { status: 'SUSPENDED' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_INVALID');
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: world.a.shopId } })).status).toBe('ACTIVE');
  });

  it('dashboard shows platform counts and no customer data', async () => {
    await newOrder(app, prisma, world.a);
    await newOrder(app, prisma, world.b);
    const d = (await call(app, admin, 'GET', '/admin/dashboard')).json().data;
    expect(d).toMatchObject({ totalShops: 2, shopsByStatus: { ACTIVE: 2, SUSPENDED: 0 }, activeSubscriptions: 2, ordersToday: 2 });
  });

  it('dashboard adds totals, status breakdown, recent shops and recent orders (metadata only)', async () => {
    const a1 = await newOrder(app, prisma, world.a);
    await newOrder(app, prisma, world.b);
    const d = (await call(app, admin, 'GET', '/admin/dashboard')).json().data;
    expect(d.totalOrders).toBe(2);
    expect(d.ordersByStatus).toMatchObject({ NEW: 2, PRINTED: 0 });
    const opts = a1.order.printOptionsSnapshot as { copies?: number };
    expect(d.totalPages).toBeGreaterThanOrEqual(a1.quote.selectedPageCount * (opts.copies ?? 1));
    expect(d.recentShops).toHaveLength(2);
    expect(d.recentOrders).toHaveLength(2);
    expect(JSON.stringify(d)).not.toMatch(/objectKey|trackingToken|passwordHash|notes.pdf|originalFilename|fileName/i);
  });

  it('GET /admin/orders returns safe operational metadata only and supports shop/status filters', async () => {
    const a1 = await newOrder(app, prisma, world.a);
    const b1 = await newOrder(app, prisma, world.b);
    const res = await call(app, admin, 'GET', '/admin/orders');
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    const row = items.find((i) => i.id === a1.order.id)!;
    expect(row).toMatchObject({
      shopSlug: world.a.slug,
      orderNumber: a1.order.orderNumber,
      status: 'NEW',
      totalPaise: a1.order.totalPaise,
      pageCount: 10,
      documentStatus: 'AVAILABLE'
    });
    for (const key of ['colourMode', 'sides', 'copies', 'paperSize', 'pageSelection', 'selectedPageCount', 'printedAt', 'deleteAfter', 'deletedAt']) {
      expect(row, key).toHaveProperty(key);
    }
    // Privacy: no customer filename, storage keys, tracking tokens, URLs or content handles.
    expect(res.body).not.toContain('notes.pdf');
    expect(res.body).not.toMatch(/fileName|originalFilename/i);
    expect(row).not.toHaveProperty('fileName');
    expect(res.body).not.toContain(a1.doc.objectKey);
    expect(res.body).not.toContain(a1.trackingToken);
    expect(res.body).not.toContain(b1.trackingToken);
    expect(res.body).not.toMatch(/objectKey|trackingToken|"url"|signature/i);

    const onlyA = (await call(app, admin, 'GET', `/admin/orders?shopId=${world.a.shopId}`)).json().data.items;
    expect(onlyA.map((i: { id: string }) => i.id)).toEqual([a1.order.id]);
    expect((await call(app, admin, 'GET', '/admin/orders?status=PRINTED')).json().data.items).toHaveLength(0);
    expect((await call(app, admin, 'GET', '/admin/orders?status=BOGUS')).statusCode).toBe(400);
    expect((await call(app, admin, 'GET', '/admin/orders?evil=1')).statusCode).toBe(400);
  });

  it('PLATFORM_ADMIN cannot obtain document access (content stays with the owning shop)', async () => {
    const a1 = await newOrder(app, prisma, world.a);
    const res = await call(app, admin, 'POST', `/shop/orders/${a1.order.id}/document-access`, {});
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toMatch(/https?:\/\//);
    const orderRes = await call(app, admin, 'GET', `/shop/orders/${a1.order.id}`);
    expect(orderRes.statusCode).toBe(403);
  });

  it('shop list shows owner, order count and last activity; shop detail adds status counts, pricing and recent orders', async () => {
    const a1 = await newOrder(app, prisma, world.a);
    const list = (await call(app, admin, 'GET', '/admin/shops')).json().data.items as Array<Record<string, any>>;
    const rowA = list.find((s) => s.id === world.a.shopId)!;
    const rowB = list.find((s) => s.id === world.b.shopId)!;
    expect(rowA).toMatchObject({ owner: { email: world.a.ownerEmail }, orderCount: 1 });
    expect(rowA.lastOrderAt).toBeTruthy();
    expect(rowB).toMatchObject({ orderCount: 0, lastOrderAt: null });
    expect(JSON.stringify(list)).not.toContain('passwordHash');

    const d = (await call(app, admin, 'GET', `/admin/shops/${world.a.shopId}`)).json().data;
    expect(d.ordersByStatus).toMatchObject({ NEW: 1 });
    expect(d.pricingRules).toHaveLength(4);
    expect(d.usage.pricingRuleCount).toBe(4);
    expect(d.recentOrders.map((o: { id: string }) => o.id)).toEqual([a1.order.id]);
    expect(JSON.stringify(d)).not.toMatch(/objectKey|trackingToken|passwordHash|notes.pdf|originalFilename|fileName/i);
  });

  it('creates a shop with an owner who can then log in; validates and de-duplicates slugs/emails', async () => {
    const body = { slug: 'new-shop', displayName: 'New Shop', owner: { email: 'Boss@New.test', displayName: 'Boss', password: 'a-long-password-1' }, planId: world.planId };
    const res = await call(app, admin, 'POST', '/admin/shops', body);
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('a-long-password-1');
    expect(res.body).not.toContain('passwordHash');
    expect(res.json().data.owner.email).toBe('boss@new.test');
    const newOwner = await login(app, 'boss@new.test', 'a-long-password-1');
    expect((await call(app, newOwner, 'GET', '/shop/settings')).statusCode).toBe(200);

    const dupSlug = await call(app, admin, 'POST', '/admin/shops', { ...body, owner: { ...body.owner, email: 'other@new.test' } });
    expect(dupSlug.statusCode).toBe(409);
    expect(dupSlug.json().error.details).toEqual({ field: 'slug' });
    const dupEmail = await call(app, admin, 'POST', '/admin/shops', { ...body, slug: 'another-shop' });
    expect(dupEmail.statusCode).toBe(409);
    for (const slug of ['Bad Slug', 'ab', 'admin', '-lead', 'a--b', 'x'.repeat(61)]) {
      expect((await call(app, admin, 'POST', '/admin/shops', { ...body, slug })).statusCode, slug).toBe(400);
    }
    expect((await call(app, admin, 'POST', '/admin/shops', { ...body, slug: 'weak-pass', owner: { ...body.owner, email: 'w@x.test', password: 'short' } })).statusCode).toBe(400);
    expect((await call(app, admin, 'POST', '/admin/shops', { ...body, slug: 'extra-key', role: 'PLATFORM_ADMIN' })).statusCode).toBe(400);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'admin.shop.create' } });
    expect(JSON.stringify(audit.metadata)).not.toContain('a-long-password-1');
  });

  it('suspends and re-activates a shop: sessions die, public access blocked, audit logged', async () => {
    const res = await call(app, admin, 'PUT', `/admin/shops/${world.a.shopId}`, { status: 'SUSPENDED' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.shop.status).toBe('SUSPENDED');
    expect((await call(app, owner, 'GET', '/shop/orders')).statusCode).toBe(401); // sessions invalidated
    const relog = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: PASSWORD } });
    expect(relog.statusCode).toBe(403);
    expect(relog.json().error.code).toBe('SHOP_SUSPENDED');
    const pub = await app.inject({ method: 'GET', url: `/api/v1/public/shops/${world.a.slug}` });
    expect(pub.json().data).toMatchObject({ status: 'SUSPENDED', acceptsOrders: false });

    await call(app, admin, 'PUT', `/admin/shops/${world.a.shopId}`, { status: 'ACTIVE' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: world.a.ownerEmail, password: PASSWORD } })).statusCode).toBe(200);
    const actions = (await prisma.auditLog.findMany({ where: { shopId: world.a.shopId } })).map((a) => a.action);
    expect(actions).toContain('admin.shop.suspend');
    expect(actions).toContain('admin.shop.activate');
    expect((await call(app, admin, 'PUT', `/admin/shops/${world.a.shopId}`, { slug: 'hijack' })).statusCode).toBe(400);
  });

  it('shop detail has metadata and usage but no documents', async () => {
    const o = await newOrder(app, prisma, world.a);
    const res = await call(app, admin, 'GET', `/admin/shops/${world.a.shopId}`);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.usage).toMatchObject({ orderCount: 1, pricingRuleCount: 4 });
    expect(d.subscription.status).toBe('ACTIVE');
    expect(d.owners[0].email).toBe(world.a.ownerEmail);
    expect(res.body).not.toContain(o.doc.objectKey);
    expect(res.body).not.toContain(o.trackingToken);
    expect(res.body).not.toContain('notes.pdf'); // customer filenames are never exposed to PLATFORM_ADMIN
    expect((await call(app, admin, 'GET', '/admin/shops/doesnotexist1')).statusCode).toBe(404);
  });

  it('lists shops with cursor pagination', async () => {
    const page1 = (await call(app, admin, 'GET', '/admin/shops?limit=1')).json().data;
    expect(page1.items).toHaveLength(1);
    const page2 = (await call(app, admin, 'GET', `/admin/shops?limit=1&cursor=${page1.nextCursor}`)).json().data;
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(page2.nextCursor).toBeUndefined();
    expect((await call(app, admin, 'GET', '/admin/shops?status=SUSPENDED')).json().data.items).toHaveLength(0);
  });

  it('manages plans and subscriptions', async () => {
    const plans = (await call(app, admin, 'GET', '/admin/plans')).json().data;
    expect(plans[0]).toMatchObject({ name: 'Starter', pricePaise: 9900 });
    const upd = await call(app, admin, 'PUT', `/admin/plans/${plans[0].id}`, { pricePaise: 12900 });
    expect(upd.json().data.pricePaise).toBe(12900);
    expect((await call(app, admin, 'PUT', `/admin/plans/${plans[0].id}`, {})).statusCode).toBe(400);
    const newPlan = await call(app, admin, 'POST', '/admin/plans', { name: 'Pro', pricePaise: 19900, active: true });
    expect(newPlan.statusCode).toBe(201);
    expect((await call(app, admin, 'POST', '/admin/plans', { name: 'Pro', pricePaise: 1, active: true })).statusCode).toBe(409);

    const renews = '2027-01-01T00:00:00.000Z';
    const sub = await call(app, admin, 'PUT', `/admin/subscriptions/${world.a.shopId}`, { status: 'SUSPENDED', planId: newPlan.json().data.id, renewsAt: renews });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().data).toMatchObject({ status: 'SUSPENDED', renewsAt: renews, plan: { name: 'Pro' } });
    expect((await call(app, admin, 'PUT', `/admin/subscriptions/${world.a.shopId}`, { status: 'BOGUS' })).statusCode).toBe(400);
    expect((await call(app, admin, 'PUT', `/admin/subscriptions/${world.a.shopId}`, { planId: 'nonexistent1' })).statusCode).toBe(400);
    const list = (await call(app, admin, 'GET', '/admin/subscriptions?status=SUSPENDED')).json().data;
    expect(list.items).toHaveLength(1);
    expect((await call(app, admin, 'GET', '/admin/dashboard')).json().data.activeSubscriptions).toBe(1);
  });

  it('audit logs are cursor-paginated, newest first, filterable and secret-free', async () => {
    await call(app, admin, 'PUT', `/admin/shops/${world.a.shopId}`, { displayName: 'Renamed' });
    await call(app, admin, 'PUT', `/admin/shops/${world.b.shopId}`, { displayName: 'Renamed B' });
    const p1 = (await call(app, admin, 'GET', '/admin/audit-logs?limit=2')).json().data;
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await call(app, admin, 'GET', `/admin/audit-logs?limit=2&cursor=${p1.nextCursor}`)).json().data;
    expect(p2.items.length).toBeGreaterThan(0);
    const filtered = (await call(app, admin, 'GET', `/admin/audit-logs?shopId=${world.a.shopId}&action=admin.shop.update`)).json().data;
    expect(filtered.items).toHaveLength(1);
    const all = JSON.stringify((await call(app, admin, 'GET', '/admin/audit-logs?limit=100')).json());
    expect(all).not.toMatch(/passwordHash|csrf|token/i);
  });
});
