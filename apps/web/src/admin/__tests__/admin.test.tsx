import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminRoutes from '../AdminRoutes';
import { getCsrfToken, setCsrfToken } from '../../lib/api';
import { rupeesToPaise, slugHint } from '../../lib/admin-api';
import { mockFetch, type Handler } from '../../shop/__tests__/helpers';

beforeEach(() => setCsrfToken(null));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const adminSession = { user: { id: 'a1', displayName: 'Root', role: 'PLATFORM_ADMIN' }, shop: null, csrfToken: 'csrf-a' };
const shopSession = { user: { id: 'u1', displayName: 'Owner', role: 'SHOP_OWNER' }, shop: { id: 's1', slug: 'c', displayName: 'C' }, csrfToken: 'csrf-s' };
const authed: Handler = ({ method, path }) => (method === 'GET' && path === '/auth/session' ? { data: adminSession } : undefined);
const anon: Handler = ({ method, path }) => (method === 'GET' && path === '/auth/session' ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined);

function renderAdmin(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/*" element={<AdminRoutes />} />
        <Route path="/shop/*" element={<div>SHOP AREA</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const shop = (over: object = {}) => ({
  id: 'shop-0001', slug: 'central', displayName: 'Central Print', address: null, status: 'ACTIVE', acceptsOrders: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over
});
const plan = { id: 'plan-0001', name: 'Standard', pricePaise: 9900, active: true };
const sub = { id: 'sub-0001', shopId: 'shop-0001', status: 'ACTIVE', renewsAt: null, updatedAt: '2026-01-01T00:00:00Z', plan };

const order = (over: object = {}) => ({
  id: 'ord-0001', shopId: 'shop-0001', shopSlug: 'central', shopName: 'Central Print', orderNumber: 'CEN-0001', status: 'PRINTED',
  customerDisplayNameOrReference: 'Ravi', totalPaise: 1200, currency: 'INR', createdAt: '2026-01-02T05:00:00Z', updatedAt: '2026-01-02T05:10:00Z',
  mimeType: 'application/pdf', pageCount: 10, selectedPageCount: 4, paperSize: 'A4', colourMode: 'bw', sides: 'duplex', copies: 2,
  pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 4 }] }, documentStatus: 'PRINTED_RETENTION', printedAt: '2026-01-02T05:05:00Z',
  deleteAfter: '2026-01-02T05:35:00Z', deletedAt: null, ...over
});
const dashExtra = {
  totalOrders: 123, ordersByStatus: { NEW: 1, PRINTED: 2 }, totalPages: 456,
  recentShops: [shop()], recentOrders: [order()]
};

describe('pure helpers', () => {
  it('converts rupees to paise without float error', () => {
    expect(rupeesToPaise('99')).toBe(9900);
    expect(rupeesToPaise('99.5')).toBe(9950);
    expect(rupeesToPaise('0.29')).toBe(29);
    expect(rupeesToPaise('1.005')).toBeNull();
    expect(rupeesToPaise('-1')).toBeNull();
    expect(rupeesToPaise('abc')).toBeNull();
  });
  it('slug hint', () => {
    expect(slugHint('ok-slug')).toBeNull();
    expect(slugHint('Bad Slug')).toMatch(/lowercase/i);
    expect(slugHint('ab')).toMatch(/3/);
  });
});

describe('admin auth', () => {
  it('redirects anonymous users to /admin/login and signs in an admin, setting csrf', async () => {
    const user = userEvent.setup();
    let loggedIn = false;
    const { calls } = mockFetch(
      (r) => (loggedIn ? authed(r) : anon(r)),
      ({ method, path }) => { if (method === 'POST' && path === '/auth/login') { loggedIn = true; return { data: adminSession }; } return undefined; },
      ({ path }) => (path === '/admin/dashboard' ? { data: { timezone: 'Asia/Kolkata', totalShops: 2, shopsByStatus: { ACTIVE: 2, SUSPENDED: 0 }, activeSubscriptions: 1, subscriptionsByStatus: { ACTIVE: 1 }, ordersToday: 7, ...dashExtra } } : undefined)
    );
    renderAdmin('/admin');
    expect(await screen.findByRole('heading', { name: /admin sign in/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'admin@printout.test');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ email: 'admin@printout.test', password: 'pw' });
    expect(getCsrfToken()).toBe('csrf-a');
  });

  it('redirects a SHOP_OWNER session to /shop', async () => {
    mockFetch(({ method, path }) => (method === 'GET' && path === '/auth/session' ? { data: shopSession } : undefined));
    renderAdmin('/admin/shops');
    expect(await screen.findByText('SHOP AREA')).toBeInTheDocument();
  });

  it('redirects a SHOP_OWNER who logs in at /admin/login to /shop', async () => {
    const user = userEvent.setup();
    mockFetch(anon, ({ method, path }) => (method === 'POST' && path === '/auth/login' ? { data: shopSession } : undefined));
    renderAdmin('/admin/login');
    await user.type(await screen.findByLabelText('Email'), 'o@c.test');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('SHOP AREA')).toBeInTheDocument();
  });

  it('shows a generic error on bad credentials', async () => {
    const user = userEvent.setup();
    mockFetch(anon, ({ method, path }) => (method === 'POST' && path === '/auth/login' ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined));
    renderAdmin('/admin/login');
    await user.type(await screen.findByLabelText('Email'), 'x@y.test');
    await user.type(screen.getByLabelText('Password'), 'bad');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
  });
});

describe('dashboard', () => {
  it('renders counts', async () => {
    mockFetch(authed, ({ path }) => (path === '/admin/dashboard' ? { data: { timezone: 'Asia/Kolkata', totalShops: 5, shopsByStatus: { ACTIVE: 4, SUSPENDED: 1 }, activeSubscriptions: 3, subscriptionsByStatus: { ACTIVE: 3, SUSPENDED: 0, CANCELLED: 2 }, ordersToday: 42, ...dashExtra } } : undefined));
    renderAdmin('/admin');
    expect(await screen.findByText('42')).toBeInTheDocument();
    const totals = screen.getByLabelText('Platform totals');
    expect(within(totals).getByText('5')).toBeInTheDocument();
    expect(within(totals).queryByText(/subscription/i)).toBeNull();
    expect(screen.getAllByText('Suspended')).toHaveLength(1);
  });
});

describe('403 handling', () => {
  it('shows an access-denied message when the API returns 403 FORBIDDEN', async () => {
    mockFetch(authed, ({ path }) => (path === '/admin/dashboard' ? { status: 403, error: { code: 'FORBIDDEN', message: 'Platform admin required' } } : undefined));
    renderAdmin('/admin');
    expect(await screen.findByRole('alert')).toHaveTextContent(/access denied/i);
  });
});

describe('create shop', () => {
  const plansH: Handler = ({ method, path }) => (method === 'GET' && path === '/admin/plans' ? { data: [plan] } : undefined);

  it('validates client-side before calling the API', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authed, plansH);
    renderAdmin('/admin/shops/new');
    await user.type(await screen.findByLabelText(/^Slug/), 'Bad Slug');
    await user.click(screen.getByRole('button', { name: 'Create shop' }));
    expect(await screen.findByText(/lowercase letters, digits and single hyphens only/i)).toBeInTheDocument();
    expect(screen.getByText('Shop name is required.')).toBeInTheDocument();
    expect(screen.getByText('At least 12 characters.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText(/^Shop name/), 'Central Print');
    await user.type(screen.getByLabelText(/^Slug/), 'central');
    await user.type(screen.getByLabelText(/^Owner name/), 'Asha');
    await user.type(screen.getByLabelText(/^Owner email/), 'asha@central.test');
    await user.type(screen.getByLabelText(/^Initial password/), 'correct-horse-battery');
  }

  it('shows a duplicate slug error from 409', async () => {
    const user = userEvent.setup();
    mockFetch(authed, plansH, ({ method, path }) => (method === 'POST' && path === '/admin/shops' ? { status: 409, error: { code: 'CONFLICT', message: 'Slug already in use', details: { field: 'slug' } } as never } : undefined));
    renderAdmin('/admin/shops/new');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create shop' }));
    expect(await screen.findByText(/slug is already taken/i)).toBeInTheDocument();
  });

  it('shows a duplicate email error from 409', async () => {
    const user = userEvent.setup();
    mockFetch(authed, plansH, ({ method, path }) => (method === 'POST' && path === '/admin/shops' ? { status: 409, error: { code: 'CONFLICT', message: 'Email already in use', details: { field: 'owner.email' } } as never } : undefined));
    renderAdmin('/admin/shops/new');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create shop' }));
    expect(await screen.findByText(/account with this email already exists/i)).toBeInTheDocument();
  });

  it('creates the shop, sending the expected body, and shows the password once', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authed, plansH, ({ method, path }) => (method === 'POST' && path === '/admin/shops' ? { status: 201, data: { shop: shop(), owner: { id: 'u', email: 'asha@central.test', displayName: 'Asha' } } } : undefined));
    renderAdmin('/admin/shops/new');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create shop' }));
    expect(await screen.findByTestId('initial-password')).toHaveTextContent('correct-horse-battery');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      slug: 'central', displayName: 'Central Print', owner: { email: 'asha@central.test', displayName: 'Asha', password: 'correct-horse-battery' }
    });
  });
});

describe('shop detail', () => {
  function setup(extra: Handler[] = []) {
    let status = 'ACTIVE';
    const h = mockFetch(
      authed,
      ({ method, path }) => (method === 'GET' && path === '/admin/shops/shop-0001' ? { data: { shop: shop({ status }), owners: [{ id: 'u', email: 'asha@central.test', displayName: 'Asha', role: 'SHOP_OWNER' }], subscription: sub, usage: { orderCount: 10, ordersLast30Days: 4, pricingRuleCount: 2, lastOrderAt: null }, ordersByStatus: { NEW: 1, PRINTED: 2 }, pricingRules: [{ id: 'r1', paperSize: 'A4', colourMode: 'bw', sides: 'single', pricePerSheetPaise: 200, active: true }], recentOrders: [order()] } } : undefined),
      ({ method, path }) => (method === 'PUT' && path === '/admin/shops/shop-0001' ? (status = 'SUSPENDED', { data: { shop: shop({ status }) } }) : undefined),
      ({ method, path }) => (method === 'GET' && path === '/admin/plans' ? { data: [plan] } : undefined),
      ({ method, path }) => (method === 'GET' && path === '/admin/audit-logs' ? { data: { items: [] } } : undefined),
      ...extra
    );
    return h;
  }

  it('requires confirmation (explaining the effect) before suspending', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    renderAdmin('/admin/shops/shop-0001');
    await user.click(await screen.findByRole('button', { name: 'Suspend shop' }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveTextContent(/every signed-in session/i);
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Suspend shop' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, suspend' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ status: 'SUSPENDED' }));
    expect(await screen.findByRole('button', { name: 'Activate shop' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.headers['x-csrf-token']).toBe('csrf-a');
  });

});

describe('platform visibility (metadata only)', () => {
  it('dashboard shows total orders/pages, recent shops and recent orders', async () => {
    mockFetch(authed, ({ path }) => (path === '/admin/dashboard' ? { data: { timezone: 'Asia/Kolkata', totalShops: 5, shopsByStatus: { ACTIVE: 4, SUSPENDED: 1 }, activeSubscriptions: 3, subscriptionsByStatus: { ACTIVE: 3 }, ordersToday: 42, ...dashExtra } } : undefined));
    renderAdmin('/admin');
    expect(await screen.findByText('123')).toBeInTheDocument();
    expect(screen.getByText('456')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent shops' })).toBeInTheDocument();
    expect(screen.getByText('CEN-0001')).toBeInTheDocument();
  });

  it('orders page lists safe order metadata and offers no document access', async () => {
    const { calls } = mockFetch(authed, ({ method, path }) => (method === 'GET' && path.startsWith('/admin/orders') ? { data: { items: [order(), order({ id: 'ord-2', orderNumber: 'CEN-0002', documentStatus: 'DELETED', deletedAt: '2026-01-02T05:36:00Z' })] } } : undefined));
    renderAdmin('/admin/orders');
    const rows = await screen.findAllByTestId('admin-order');
    expect(rows).toHaveLength(2);
    expect(screen.queryByText(/notes\.pdf/)).toBeNull();
    expect(rows[0]).toHaveTextContent('Double-sided');
    expect(rows[0]).toHaveTextContent('Pages 1–4');
    expect(rows[0]).toHaveTextContent('2 copies');
    expect(rows[0]).toHaveTextContent('Retained until');
    expect(rows[1]).toHaveTextContent('Document deleted');
    expect(screen.queryByRole('button', { name: /print|download|open document/i })).toBeNull();
    expect(calls.some((c) => c.path.includes('document-access'))).toBe(false);
  });

  it('shop detail shows read-only pricing, status counts and recent orders', async () => {
    mockFetch(authed,
      ({ method, path }) => (method === 'GET' && path === '/admin/shops/shop-0001' ? { data: { shop: shop(), owners: [], subscription: sub, usage: { orderCount: 3, ordersLast30Days: 3, pricingRuleCount: 1, lastOrderAt: null }, ordersByStatus: { NEW: 1, PRINTED: 2 }, pricingRules: [{ id: 'r1', paperSize: 'A4', colourMode: 'bw', sides: 'single', pricePerSheetPaise: 200, active: true }], recentOrders: [order()] } } : undefined),
      ({ path }) => (path === '/admin/plans' ? { data: [plan] } : path.startsWith('/admin/audit-logs') ? { data: { items: [] } } : undefined));
    renderAdmin('/admin/shops/shop-0001');
    expect(await screen.findByRole('heading', { name: 'Pricing (read only)' })).toBeInTheDocument();
    expect(screen.getByText('₹2.00 / sheet')).toBeInTheDocument();
    expect(screen.getByText('CEN-0001')).toBeInTheDocument();
  });
});

describe('plans and subscriptions are gone from the admin UI', () => {
  it('has no Plans or Subscriptions navigation and the old routes fall back to the dashboard', async () => {
    mockFetch(authed, ({ path }) => (path === '/admin/dashboard' ? { data: { timezone: 'Asia/Kolkata', totalShops: 1, shopsByStatus: {}, ordersToday: 0, ...dashExtra } } : undefined));
    renderAdmin('/admin/plans');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /plans|subscriptions/i })).toBeNull();
  });
});

describe('audit log chips', () => {
  it('shows compact action, actor and entity chips with a timestamp, using only real action names', async () => {
    mockFetch(authed, ({ path }) => (path.startsWith('/admin/audit-logs') ? { data: { items: [
      { id: 'a1', shopId: 's1', actorUserId: 'u1', action: 'shop.verify', targetType: 'shop', targetId: 's1', metadata: {}, createdAt: '2026-10-01T10:00:00Z' },
      { id: 'a2', shopId: 's1', actorUserId: 'u2', action: 'order.transition', targetType: 'order', targetId: 'o1', metadata: {}, createdAt: '2026-10-01T11:00:00Z' },
      { id: 'a3', shopId: null, actorUserId: null, action: 'something.unmapped', targetType: null, targetId: null, metadata: {}, createdAt: '2026-10-01T12:00:00Z' }
    ] } } : undefined));
    renderAdmin('/admin/audit');
    const rows = await screen.findAllByTestId('audit-chips');
    expect(rows[0]).toHaveTextContent('Shop verified');
    expect(rows[0]).toHaveTextContent('Admin');
    expect(rows[0]).toHaveTextContent('Shop');
    expect(rows[1]).toHaveTextContent('Order updated');
    expect(rows[1]).toHaveTextContent('Shop owner');
    expect(rows[2]).toHaveTextContent('something.unmapped');
    expect(rows[2]).toHaveTextContent('System');
  });
});

describe('shop detail: danger zone (delete shop)', () => {
  function setupDelete(ordersByStatus: object, del: Parameters<typeof mockFetch>[0]) {
    return mockFetch(
      authed,
      ({ method, path }) => (method === 'GET' && path === '/admin/shops/shop-0001' ? { data: { shop: shop(), owners: [], subscription: sub, usage: { orderCount: 1, ordersLast30Days: 1, pricingRuleCount: 0, lastOrderAt: null }, ordersByStatus, pricingRules: [], recentOrders: [] } } : undefined),
      ({ method, path }) => (method === 'GET' && path === '/admin/audit-logs' ? { data: { items: [] } } : undefined),
      ({ method, path }) => (method === 'GET' && path.startsWith('/admin/shops') && path !== '/admin/shops/shop-0001' ? { data: { items: [] } } : undefined),
      del
    );
  }
  const openModal = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: /Delete shop/ }));
    return screen.findByRole('dialog');
  };

  it('explains the effect and keeps delete disabled until the exact slug and password are entered', async () => {
    const user = userEvent.setup();
    const { calls } = setupDelete({ PRINTED: 2 }, () => undefined);
    renderAdmin('/admin/shops/shop-0001');
    expect(await screen.findByRole('heading', { name: 'Danger zone' })).toBeInTheDocument();
    const dlg = await openModal(user);
    const confirm = within(dlg).getByRole('button', { name: 'Delete permanently' });
    expect(confirm).toBeDisabled();
    expect(within(dlg).queryByLabelText(/active orders/i)).toBeNull();
    await user.type(within(dlg).getByLabelText(/Type the shop slug/), 'centra');
    await user.type(within(dlg).getByLabelText('Your admin password'), 'pw');
    expect(confirm).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Type the shop slug/), 'l');
    expect(confirm).toBeEnabled();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('shows a clear error and keeps the modal open when the server refuses', async () => {
    const user = userEvent.setup();
    setupDelete({}, ({ method }) => (method === 'DELETE' ? { status: 403, error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect.' } } : undefined));
    renderAdmin('/admin/shops/shop-0001');
    const dlg = await openModal(user);
    await user.type(within(dlg).getByLabelText(/Type the shop slug/), 'central');
    await user.type(within(dlg).getByLabelText('Your admin password'), 'bad');
    await user.click(within(dlg).getByRole('button', { name: 'Delete permanently' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(/password is incorrect/i);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('requires the active-orders checkbox when orders are in progress, then deletes and returns to the shop list with a toast', async () => {
    const user = userEvent.setup();
    const { calls } = setupDelete({ NEW: 2, PRINTED: 1 }, ({ method, path }) => (method === 'DELETE' && path === '/admin/shops/shop-0001' ? { data: { deleted: true, shopId: 'shop-0001', slug: 'central', counts: {}, owners: { deleted: 1, detached: 0 } } } : undefined));
    renderAdmin('/admin/shops/shop-0001');
    const dlg = await openModal(user);
    await user.type(within(dlg).getByLabelText(/Type the shop slug/), 'central');
    await user.type(within(dlg).getByLabelText('Your admin password'), 'pw');
    const confirm = within(dlg).getByRole('button', { name: 'Delete permanently' });
    expect(confirm).toBeDisabled();
    await user.click(within(dlg).getByLabelText(/Also delete shop with active orders/));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(await screen.findByRole('heading', { name: 'Shops' })).toBeInTheDocument();
    expect(await screen.findByText('Deleted Central Print')).toBeInTheDocument();
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.body).toEqual({ confirmSlug: 'central', currentPassword: 'pw', force: true });
    expect(del.headers['x-csrf-token']).toBe('csrf-a');
  });
});
