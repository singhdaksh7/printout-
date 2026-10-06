import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, emptyList, mockFetch, renderShop, session, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';
import type { PricingRule } from '../../lib/shop-api';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const rule = (o: Partial<PricingRule>): PricingRule => ({ id: 'r1', paperSize: 'A4', colourMode: 'bw', sides: 'single', pricePerSheetPaise: 200, active: true, ...o });

function pricingApi(store: { rules: PricingRule[] }, extra?: Handler): Handler[] {
  return [
    ...(extra ? [extra] : []),
    ({ method, path }) => (method === 'GET' && path === '/shop/pricing-rules' ? { data: store.rules } : undefined),
    ({ method, path, body }) => {
      if (method === 'POST' && path === '/shop/pricing-rules') { const r = rule({ ...body, id: `n${store.rules.length}` }); store.rules.push(r); return { data: r }; }
      const m = /^\/shop\/pricing-rules\/(.+)$/.exec(path);
      if (method === 'PUT' && m) { store.rules = store.rules.map((r) => (r.id === m[1] ? { ...r, ...body } : r)); return { data: store.rules.find((r) => r.id === m[1]) }; }
      return undefined;
    }
  ];
}

describe('pricing editor', () => {
  it('renders the 2x2 matrix with rupee values and duplex help text', async () => {
    mockFetch(authedSession, emptyList, ...pricingApi({ rules: [rule({}), rule({ id: 'r2', sides: 'duplex', pricePerSheetPaise: 350 })] }));
    renderShop('/shop/pricing');
    expect(await screen.findByLabelText('B&W · Single-sided')).toHaveValue('2.00');
    expect(screen.getByLabelText('B&W · Duplex')).toHaveValue('3.50');
    expect(screen.getByLabelText('Colour · Single-sided')).toHaveValue('');
    expect(screen.getByLabelText('Colour · Duplex')).toHaveValue('');
    expect(screen.getByText(/Duplex is charged per physical sheet \(2 pages per sheet\)/)).toBeInTheDocument();
  });

  it('converts rupees to paise, updating existing rules (PUT) and creating missing ones (POST); shows unsaved state + toast', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, emptyList, ...pricingApi({ rules: [rule({})] }));
    renderShop('/shop/pricing');
    const bw = await screen.findByLabelText('B&W · Single-sided');
    expect(screen.getByRole('button', { name: 'Save prices' })).toBeDisabled();
    await user.clear(bw); await user.type(bw, '2.5');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Colour · Duplex'), '12.05');
    await user.click(screen.getByRole('button', { name: 'Save prices' }));
    expect(await screen.findByText('Pricing saved')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/shop/pricing-rules/r1');
    expect(put.body).toEqual({ pricePerSheetPaise: 250, active: true });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ paperSize: 'A4', colourMode: 'colour', sides: 'duplex', pricePerSheetPaise: 1205, active: true });
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
    expect(screen.getByLabelText('B&W · Single-sided')).toHaveValue('2.50');
  });

  it.each([['abc'], ['-1'], ['0'], ['0.00'], ['1.234'], ['999999'], ['NaN']])('rejects invalid price %s without calling the API', async (bad) => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, emptyList, ...pricingApi({ rules: [rule({})] }));
    renderShop('/shop/pricing');
    const bw = await screen.findByLabelText('B&W · Single-sided');
    await user.clear(bw); await user.type(bw, bad);
    await user.click(screen.getByRole('button', { name: 'Save prices' }));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(calls.some((c) => c.method === 'PUT' || c.method === 'POST')).toBe(false);
  });

  it('reset restores saved values', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, ...pricingApi({ rules: [rule({})] }));
    renderShop('/shop/pricing');
    const bw = await screen.findByLabelText('B&W · Single-sided');
    await user.type(bw, '9');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('B&W · Single-sided')).toHaveValue('2.00');
  });

  it('shows per-row error for duplicate (409) and reloads', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, ({ method, path }) => (method === 'POST' && path === '/shop/pricing-rules' ? { status: 409, error: { code: 'CONFLICT', message: 'dup' } } : undefined), ...pricingApi({ rules: [] }));
    renderShop('/shop/pricing');
    await user.type(await screen.findByLabelText('B&W · Single-sided'), '2');
    await user.click(screen.getByRole('button', { name: 'Save prices' }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByText('Some prices could not be saved.')).toBeInTheDocument();
  });

  it('warns on unload and on in-app navigation while there are unsaved changes', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, ...pricingApi({ rules: [rule({})] }));
    renderShop('/shop/pricing');
    await user.type(await screen.findByLabelText('B&W · Single-sided'), '1');
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('link', { name: /queue/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Pricing' })).toBeInTheDocument();
    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole('link', { name: /queue/i }));
    expect(await screen.findByRole('heading', { name: 'Print queue' })).toBeInTheDocument();
  });
});

describe('QR page', () => {
  it.each([[1, '1 minute'], [45, '45 minutes']])('poster note follows the session retentionMinutes=%s', async (n, phrase) => {
    const sess: Handler = ({ method, path }) => (method === 'GET' && path === '/auth/session' ? { data: session({ retentionMinutes: n }) } : undefined);
    mockFetch(sess, emptyList, ({ path }) => (path === '/shop/qr' ? { data: { publicUrl: 'https://printout.test/p/central', slug: 'central' } } : undefined));
    renderShop('/shop/qr');
    const poster = await screen.findByTestId('qr-poster');
    expect(within(poster).getByText(`Documents are automatically deleted ${phrase} after printing.`)).toBeInTheDocument();
  });

  it('renders the QR, copy/download actions and a single-page poster', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockFetch(authedSession, emptyList, ({ path }) => (path === '/shop/qr' ? { data: { publicUrl: 'https://printout.test/p/central', slug: 'central' } } : undefined));
    renderShop('/shop/qr');
    const poster = await screen.findByTestId('qr-poster');
    expect(within(poster).getByText('SCAN TO PRINT')).toBeInTheDocument();
    expect(poster.querySelector('svg')).not.toBeNull();
    const steps = within(poster).getAllByRole('listitem').map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
    expect(steps).toEqual(['1. Upload', '2. Choose settings', '3. Send order']);
    expect(within(poster).getByText('Central Print')).toBeInTheDocument();
    expect(within(poster).getByText('https://printout.test/p/central')).toBeInTheDocument();
    expect(within(poster).getByText('Documents are automatically deleted 30 minutes after printing.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith('https://printout.test/p/central');
    expect(screen.getByRole('button', { name: 'Download PNG' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download SVG' })).toBeInTheDocument();
  });

  it('?poster=1 shows the poster view and printing calls window.print', async () => {
    const user = userEvent.setup();
    const print = vi.fn();
    vi.stubGlobal('print', print);
    mockFetch(authedSession, emptyList, ({ path }) => (path === '/shop/qr' ? { data: { publicUrl: 'https://printout.test/p/central', slug: 'central' } } : undefined));
    const { container } = renderShop('/shop/qr?poster=1');
    await screen.findByTestId('qr-poster');
    expect(container.querySelector('.qr-page.poster-mode')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Print A4 poster' }));
    await waitFor(() => expect(print).toHaveBeenCalled());
  });
});

describe('analytics', () => {
  it('labels order value as "Estimated order value", never "Revenue"', async () => {
    mockFetch(authedSession, emptyList, ({ path }) => (path === '/shop/analytics' ? { data: {
      ordersByStatus: { NEW: 2, COLLECTED: 3 }, orderCount: 5, estimatedOrderValuePaise: 123450, pagesRepresented: 77, printedDocumentCount: 3,
      bwCount: 3, colourCount: 1, ordersToday: 5, pagesToday: 77, recentActivity: [{ orderId: 'o9', orderNumber: 'CENT-9', toStatus: 'NEW', at: new Date().toISOString(), totalPaise: 500 }]
    } } : undefined));
    renderShop('/shop/analytics');
    expect(await screen.findByText('Estimated order value')).toBeInTheDocument();
    expect(screen.getByText('₹1234.50')).toBeInTheDocument();
    expect(screen.getByText('77')).toBeInTheDocument();
    expect(screen.getByText(/B&W 3/)).toBeInTheDocument();
    expect(screen.getByText('#CENT-9')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/revenue/i);
  });

  it('uses the print-initiated model: no "Documents printed", no status backlog, accurate wording', async () => {
    mockFetch(authedSession, emptyList, ({ path }) => (path === '/shop/analytics' ? { data: {
      ordersByStatus: { PRINTING: 40 }, orderCount: 40, ordersToday: 40, printsInitiated: 40, newPrintRequests: 2, documentsAutoDeleted: 38, bwCount: 40, colourCount: 0
    } } : undefined));
    renderShop('/shop/analytics');
    expect(await screen.findByText('Prints initiated')).toBeInTheDocument();
    expect(screen.getByText('New print requests')).toBeInTheDocument();
    expect(screen.getByText('Files deleted automatically')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/documents printed|orders by status/i);
  });

  it('shows an error with retry', async () => {
    mockFetch(authedSession, emptyList, ({ path }) => (path === '/shop/analytics' ? { status: 500, error: { code: 'INTERNAL' } } : undefined));
    renderShop('/shop/analytics');
    expect(await screen.findByRole('alert')).toHaveTextContent(/server had a problem/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('settings', () => {
  it('loads, validates, and saves only the allowed fields', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, emptyList,
      ({ path }) => (path === '/shop/qr' ? { data: { publicUrl: 'https://printout.test/p/central', slug: 'central' } } : undefined),
      ({ method, path, body }) => {
        if (path !== '/shop/settings') return undefined;
        if (method === 'PUT') return { data: { ...body } };
        return { data: { displayName: 'Central Print', address: 'MG Road', publicContact: '99999', brandColor: '#112233', acceptsOrders: true, secretInternalFlag: true } };
      });
    renderShop('/shop/settings');
    const name = await screen.findByLabelText('Shop name');
    expect(name).toHaveValue('Central Print');
    expect(await screen.findByRole('link', { name: 'https://printout.test/p/central' })).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/Brand colour/)); await user.type(screen.getByLabelText(/Brand colour/), 'red');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/Use a colour like/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await user.clear(screen.getByLabelText(/Brand colour/)); await user.type(screen.getByLabelText(/Brand colour/), '#AABBCC');
    await user.click(screen.getByLabelText('Accepting new orders'));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(Object.keys(put.body).sort()).toEqual(['acceptsOrders', 'address', 'brandColor', 'displayName', 'publicContact']);
    expect(put.body.acceptsOrders).toBe(false);
    expect(put.body.brandColor).toBe('#AABBCC');
  });
});

describe('navigation shell', () => {
  it('shows the shop name, nav links, and navigates between sections', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, ({ path }) => (path === '/shop/analytics' ? { data: { ordersByStatus: {}, orderCount: 0 } } : undefined));
    renderShop('/shop');
    expect(await screen.findByText('Central Print')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Shop sections' });
    for (const l of ['Queue', 'Pricing', 'QR', 'Analytics', 'Settings']) expect(within(nav).getByRole('link', { name: new RegExp(l) })).toBeInTheDocument();
    await user.click(within(nav).getByRole('link', { name: /Analytics/ }));
    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
  });

  it('shows an offline banner when the browser goes offline', async () => {
    mockFetch(authedSession, emptyList);
    renderShop('/shop');
    await screen.findByRole('heading', { name: 'Print queue' });
    fireEvent(window, new Event('offline'));
    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();
  });
});
