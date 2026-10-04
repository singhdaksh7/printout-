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
      ({ path }) => (path === '/admin/dashboard' ? { data: { timezone: 'Asia/Kolkata', totalShops: 2, shopsByStatus: { ACTIVE: 2, SUSPENDED: 0 }, activeSubscriptions: 1, subscriptionsByStatus: { ACTIVE: 1 }, ordersToday: 7 } } : undefined)
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
    mockFetch(authed, ({ path }) => (path === '/admin/dashboard' ? { data: { timezone: 'Asia/Kolkata', totalShops: 5, shopsByStatus: { ACTIVE: 4, SUSPENDED: 1 }, activeSubscriptions: 3, subscriptionsByStatus: { ACTIVE: 3, SUSPENDED: 0, CANCELLED: 2 }, ordersToday: 42 } } : undefined));
    renderAdmin('/admin');
    expect(await screen.findByText('42')).toBeInTheDocument();
    const totals = screen.getByLabelText('Platform totals');
    expect(within(totals).getByText('5')).toBeInTheDocument();
    expect(within(totals).getByText('3')).toBeInTheDocument();
    expect(screen.getAllByText('Suspended')).toHaveLength(2);
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
      ({ method, path }) => (method === 'GET' && path === '/admin/shops/shop-0001' ? { data: { shop: shop({ status }), owners: [{ id: 'u', email: 'asha@central.test', displayName: 'Asha', role: 'SHOP_OWNER' }], subscription: sub, usage: { orderCount: 10, ordersLast30Days: 4, pricingRuleCount: 2, lastOrderAt: null } } } : undefined),
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

  it('labels commercial info as manual and never mentions documents', async () => {
    setup();
    renderAdmin('/admin/shops/shop-0001');
    expect(await screen.findByText(/no billing automation/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/storage|tracking token|download/i);
  });

  it('saves subscription status change via PUT /admin/subscriptions/:shopId', async () => {
    const user = userEvent.setup();
    const { calls } = setup([({ method, path }) => (method === 'PUT' && path === '/admin/subscriptions/shop-0001' ? { data: { ...sub, status: 'CANCELLED' } } : undefined)]);
    renderAdmin('/admin/shops/shop-0001');
    await user.selectOptions(await screen.findByLabelText('Subscription status'), 'CANCELLED');
    await user.click(screen.getByRole('button', { name: 'Save subscription' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/admin/subscriptions/shop-0001')?.body).toEqual({ status: 'CANCELLED', planId: 'plan-0001', renewsAt: null }));
  });
});

describe('plans', () => {
  it('converts rupees to paise on save', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      authed,
      ({ method, path }) => (method === 'GET' && path === '/admin/plans' ? { data: [plan] } : undefined),
      ({ method, path }) => (method === 'PUT' && path === '/admin/plans/plan-0001' ? { data: { ...plan, pricePaise: 14950 } } : undefined)
    );
    renderAdmin('/admin/plans');
    const price = await screen.findByLabelText(/Price per month/);
    expect(price).toHaveValue('99.00');
    await user.clear(price);
    await user.type(price, '149.5');
    await user.click(screen.getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ name: 'Standard', pricePaise: 14950, active: true }));
  });

  it('blocks invalid prices', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authed, ({ path }) => (path === '/admin/plans' ? { data: [plan] } : undefined));
    renderAdmin('/admin/plans');
    const price = await screen.findByLabelText(/Price per month/);
    await user.clear(price);
    await user.type(price, '1.234');
    expect(screen.getByText(/rupee amount/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save plan' })).toBeDisabled();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('audit log', () => {
  it('paginates with the cursor and appends', async () => {
    const user = userEvent.setup();
    const entry = (n: number) => ({ id: `a${n}`, shopId: null, actorUserId: 'a1', action: `admin.thing.${n}`, targetType: 'plan', targetId: 'p', metadata: null, createdAt: '2026-01-01T00:00:00Z' });
    const { calls } = mockFetch(authed, ({ path, query }) => {
      if (path !== '/admin/audit-logs') return undefined;
      return query.get('cursor') === 'CUR1' ? { data: { items: [entry(3)] } } : { data: { items: [entry(1), entry(2)], nextCursor: 'CUR1' } };
    });
    renderAdmin('/admin/audit');
    expect(await screen.findByText('admin.thing.1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('admin.thing.3')).toBeInTheDocument();
    expect(screen.getByText('admin.thing.1')).toBeInTheDocument();
    expect(screen.getByText('End of list')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/admin/audit-logs').length).toBe(2);
  });
});
