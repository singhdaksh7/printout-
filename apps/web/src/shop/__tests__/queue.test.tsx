import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, mockFetch, order, renderShop, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';
import type { OrderSummary } from '../../lib/shop-api';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

/** Serves GET /shop/orders by status from a mutable store, with optional pagination. */
function orders(store: { items: OrderSummary[]; pageSize?: number }): Handler {
  return ({ method, path, query }) => {
    if (method !== 'GET' || path !== '/shop/orders') return undefined;
    const st = query.get('status')?.split(',');
    const all = store.items.filter((o) => (st ? st.includes(o.status) : true) && (query.get('active') !== '1' || !['COLLECTED', 'CANCELLED', 'EXPIRED'].includes(o.status)));
    const size = store.pageSize ?? 50;
    const start = Number(query.get('cursor') ?? 0);
    const items = all.slice(start, start + size);
    const next = start + size < all.length ? String(start + size) : undefined;
    return { data: { items, nextCursor: next } };
  };
}

describe('queue', () => {
  it('renders order cards with all operational details', async () => {
    const readyOrder = order({ id: 'o2', orderNumber: 'CENT-2', status: 'READY', colourMode: 'colour', sides: 'single', copies: 1, selectedPageCount: 10, pageCount: 10, createdAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    mockFetch(authedSession, orders({ items: [order(), readyOrder] }));
    renderShop('/shop');
    const cards = await screen.findAllByTestId('order-card');
    expect(cards).toHaveLength(2);
    const c = within(cards[0]!);
    expect(c.getByText('#CENT-1')).toBeInTheDocument();
    expect(c.getByText('₹12.50')).toBeInTheDocument();
    expect(c.getByText('thesis-final.pdf')).toBeInTheDocument();
    expect(c.getByText('4/10 pages')).toBeInTheDocument();
    expect(c.getByText('B&W')).toBeInTheDocument();
    expect(c.getByText('Duplex')).toBeInTheDocument();
    expect(c.getByText('2 copies')).toBeInTheDocument();
    expect(c.getByText('For: Asha')).toBeInTheDocument();
    expect(c.getByText('New')).toBeInTheDocument();
    expect(c.getByText('3 min ago')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Colour')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Single')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Order #CENT-1' })).toHaveAttribute('href', '/shop/orders/o1');
  });

  it('long filenames are truncated with the full name in a title', async () => {
    const long = `${'a'.repeat(200)}.pdf`;
    mockFetch(authedSession, orders({ items: [order({ originalFilename: long })] }));
    renderShop('/shop');
    const el = await screen.findByTitle(long);
    expect(el).toHaveClass('sh-ellip');
  });

  it('shows a friendly empty state', async () => {
    mockFetch(authedSession, orders({ items: [] }));
    renderShop('/shop');
    expect(await screen.findByText('No orders yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open counter qr/i })).toBeInTheDocument();
  });

  it('filters by status tabs using the API status parameter', async () => {
    const user = userEvent.setup();
    const { fn } = mockFetch(authedSession, orders({ items: [order(), order({ id: 'o9', orderNumber: 'CENT-9', status: 'COLLECTED' })] }));
    renderShop('/shop');
    await screen.findByText('#CENT-1');
    expect(screen.queryByText('#CENT-9')).not.toBeInTheDocument(); // Active excludes COLLECTED
    await user.click(screen.getByRole('tab', { name: 'Done' }));
    expect(await screen.findByText('#CENT-9')).toBeInTheDocument();
    expect(screen.queryByText('#CENT-1')).not.toBeInTheDocument();
    const urls = fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/shop/orders'));
    expect(urls.some((u) => u.includes('active=1'))).toBe(true);
    expect(urls.some((u) => u.includes('status=COLLECTED%2CCANCELLED%2CEXPIRED'))).toBe(true);
  });

  it('supports Load more with cursor pagination', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 5 }, (_, i) => order({ id: `n${i}`, orderNumber: `N-${i}`, createdAt: new Date(Date.now() - i * 60_000).toISOString() }));
    mockFetch(authedSession, orders({ items, pageSize: 2 }));
    renderShop('/shop');
    await screen.findByText('#N-0');
    expect(screen.getAllByTestId('order-card')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByTestId('order-card')).toHaveLength(4));
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByTestId('order-card')).toHaveLength(5));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows a new order from SSE without a manual refresh and updates the title badge', async () => {
    const store = { items: [order()] };
    mockFetch(authedSession, orders(store));
    renderShop('/shop');
    await screen.findByText('#CENT-1');
    await waitFor(() => expect(document.title).toBe('(1) Printout'));
    const es = FakeES.open[0]!;
    act(() => es.open_());
    store.items.unshift(order({ id: 'o3', orderNumber: 'CENT-3', createdAt: new Date().toISOString() }));
    act(() => es.emit('order.created', { id: 'o3', status: 'NEW' }, 'e1'));
    expect(await screen.findByText('#CENT-3')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('(2) Printout'));
  });

  it('reports connection state: Live, Reconnecting, then Live again', async () => {
    mockFetch(authedSession, orders({ items: [] }));
    renderShop('/shop');
    await screen.findByText('No orders yet');
    const es = FakeES.open[0]!;
    const status = () => screen.getByRole('status', { name: /connection/i });
    act(() => es.open_());
    expect(status()).toHaveTextContent('Live');
    act(() => es.fail(false));
    expect(status()).toHaveTextContent('Reconnecting…');
    act(() => es.open_());
    expect(status()).toHaveTextContent('Live');
  });

  it('opens a single EventSource under React StrictMode and closes it on unmount', async () => {
    mockFetch(authedSession, orders({ items: [] }));
    const { unmount } = renderShop('/shop', { strict: true });
    await screen.findByText('No orders yet');
    expect(FakeES.open).toHaveLength(1);
    expect(FakeES.open[0]!.url).toBe('/api/v1/shop/events');
    expect(FakeES.open[0]!.init).toEqual({ withCredentials: true });
    unmount();
    expect(FakeES.open).toHaveLength(0);
  });

  it('shows the live retention countdown for PRINTED orders and "File deleted" afterwards', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const deleteAfter = new Date(Date.now() + 24 * 60_000 + 10_000).toISOString();
    const store = { items: [order({ status: 'PRINTED', documentStatus: 'PRINTED_RETENTION', deleteAfter }), order({ id: 'o5', orderNumber: 'CENT-5', status: 'READY', documentStatus: 'DELETED', deleteAfter: new Date(Date.now() - 5000).toISOString() })] };
    mockFetch(authedSession, orders(store));
    renderShop('/shop');
    expect(await screen.findByText(/Deletes in 24:\d\d/)).toBeInTheDocument();
    expect(screen.getByText('File deleted')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByText(/Deletes in 23:\d\d/)).toBeInTheDocument();
  });
});
