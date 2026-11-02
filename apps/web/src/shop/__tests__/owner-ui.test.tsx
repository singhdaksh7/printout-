import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, mockFetch, order, renderShop, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';
import { deriveShopState } from '../ShopStatusBar';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const orders: Handler = ({ method, path }) => (method === 'GET' && path === '/shop/orders' ? { data: { items: [order()] } } : undefined);
const settings = (over: Record<string, unknown> = {}): Handler => ({ method, path }) =>
  method === 'GET' && path === '/shop/settings'
    ? { data: { slug: 'central', displayName: 'Central Print', address: 'x', publicContact: null, brandColor: null, acceptsOrders: true, shopStatus: 'ACTIVE', isVerified: true, ...over } }
    : undefined;
const rules = (items: unknown[]): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/pricing-rules' ? { data: items } : undefined);

describe('deriveShopState keeps availability, verification and suspension separate', () => {
  it('ranks suspension > verification > owner availability', () => {
    expect(deriveShopState({ shopStatus: 'SUSPENDED', isVerified: false, acceptsOrders: true }).state).toBe('suspended');
    expect(deriveShopState({ shopStatus: 'ACTIVE', isVerified: false, acceptsOrders: true }).state).toBe('unverified');
    expect(deriveShopState({ shopStatus: 'ACTIVE', isVerified: true, acceptsOrders: false }).state).toBe('closed');
    expect(deriveShopState({ shopStatus: 'ACTIVE', isVerified: true, acceptsOrders: true }).state).toBe('open');
  });
});

describe('shop status at the top of the dashboard', () => {
  it('shows Open and lets the owner close the shop through the settings API', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, orders, rules([]), settings(), ({ method, path, body }) =>
      method === 'PUT' && path === '/shop/settings' ? { data: { acceptsOrders: body.acceptsOrders } } : undefined);
    renderShop('/shop');
    expect(await screen.findByTestId('shop-status-chip')).toHaveTextContent('Open');
    await user.click(screen.getByRole('button', { name: 'Close shop' }));
    await waitFor(() => expect(screen.getByTestId('shop-status-chip')).toHaveTextContent('Closed'));
    expect(calls.find((c) => c.method === 'PUT' && c.path === '/shop/settings')?.body).toEqual({ acceptsOrders: false });
  });

  it('shows Awaiting verification and Suspended without any owner toggle', async () => {
    mockFetch(authedSession, orders, rules([]), settings({ isVerified: false }));
    renderShop('/shop');
    expect(await screen.findByTestId('shop-status-chip')).toHaveTextContent('Awaiting verification');
    expect(screen.queryByRole('button', { name: /close shop|open shop/i })).toBeNull();
    cleanup();
    mockFetch(authedSession, orders, rules([]), settings({ shopStatus: 'SUSPENDED' }));
    renderShop('/shop');
    expect(await screen.findByTestId('shop-status-chip')).toHaveTextContent('Suspended');
    expect(screen.queryByRole('button', { name: /close shop|open shop/i })).toBeNull();
  });
});

const statusRatesNext: Handler = ({ method, path }) => (method === 'GET' && path === '/shop/setup-status' ? { data: {
  shopId: 's1', shopStatus: 'ACTIVE', isOpen: true, isVerified: false, nextStep: 'rates', complete: false,
  sections: { profile: { complete: true, missing: [] }, rates: { complete: false, activeCount: 0, configured: [] }, paper: { complete: false, optionCount: 0 }, payments: { complete: false, methods: ['cash'], upiId: null } }
} } : undefined);

describe('rates onboarding', () => {
  it('prompts an existing shop with no active rates and links to setup', async () => {
    mockFetch(authedSession, orders, settings(), rules([]));
    renderShop('/shop');
    const banner = await screen.findByTestId('rates-missing');
    expect(within(banner).getByRole('link', { name: 'Set printing rates' })).toHaveAttribute('href', '/shop/setup');
  });

  it('does not prompt when a rate is active', async () => {
    mockFetch(authedSession, orders, settings(), rules([{ id: 'r1', paperSize: 'A4', colourMode: 'bw', sides: 'single', pricePerSheetPaise: 200, active: true }]));
    renderShop('/shop');
    await screen.findByTestId('order-card');
    await waitFor(() => expect(screen.queryByTestId('rates-missing')).toBeNull());
  });

  it('setup page shows Not configured for every combination and saves through the pricing API', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, orders, settings(), rules([]), statusRatesNext, ({ method, path, body }) =>
      method === 'POST' && path === '/shop/pricing-rules' ? { status: 201, data: { id: 'r1', ...body } } : undefined);
    renderShop('/shop/setup');
    expect(await screen.findByRole('heading', { name: 'Set your printing rates' })).toBeInTheDocument();
    expect(await screen.findAllByText('Not configured')).toHaveLength(4);
    await user.type(screen.getByLabelText(/B&W · Single-sided/), '2');
    await user.click(screen.getByRole('button', { name: 'Save prices' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/shop/pricing-rules')?.body).toMatchObject({ colourMode: 'bw', sides: 'single', pricePerSheetPaise: 200 }));
  });
});

describe('settings: no plans, Google security instead of a password form', () => {
  it('shows a Manage Google Account Security link and no password or plan content', async () => {
    mockFetch(authedSession, orders, settings(), rules([]));
    renderShop('/shop/settings');
    const card = await screen.findByTestId('account-security');
    expect(within(card).getByRole('link', { name: 'Manage Google Account Security' })).toHaveAttribute('href', 'https://myaccount.google.com/security');
    expect(document.body.textContent).not.toMatch(/plan|subscription|upgrade|billing/i);
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });
});
