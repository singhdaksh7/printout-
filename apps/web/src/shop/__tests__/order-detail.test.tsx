import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, mockFetch, order, renderShop, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';
import type { OrderDetail, OrderStatus } from '../../lib/shop-api';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function detail(status: OrderStatus, doc: Partial<OrderDetail['document']> = {}): OrderDetail {
  return {
    order: { ...order({ status }), originalFilename: 'thesis-final.pdf' },
    document: { id: 'd1', status: 'AVAILABLE', pageCount: 10, uploadedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), printedAt: null, deleteAfter: null, deletedAt: null, deletionState: 'OK', ...doc },
    priceSnapshot: { selectedPageCount: 4, sheetsPerCopy: 2, totalSheets: 4, unitPricePaise: 300, totalPaise: 1250, currency: 'INR' },
    printOptionsSnapshot: { paperSize: 'A4', colourMode: 'bw', sides: 'duplex', copies: 2, pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 3 }, { from: 7, to: 7 }] } },
    statusHistory: [{ toStatus: 'NEW', createdAt: new Date().toISOString() }]
  };
}
const getDetail = (store: { d: OrderDetail }): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/orders/o1' ? { data: store.d } : undefined);
const btn = (name: RegExp | string) => screen.queryByRole('button', { name });

describe('order detail', () => {
  it('shows configuration, price breakdown and history', async () => {
    mockFetch(authedSession, getDetail({ d: detail('NEW') }));
    renderShop('/shop/orders/o1');
    expect(await screen.findByRole('heading', { name: 'Order #CENT-1' })).toBeInTheDocument();
    expect(screen.getByText('Pages 1–3, 7 of 10')).toBeInTheDocument();
    expect(screen.getByText('Duplex (double-sided)')).toBeInTheDocument();
    expect(screen.getByText('Black & white')).toBeInTheDocument();
    expect(screen.getByText('Total sheets')).toBeInTheDocument();
    expect(screen.getByText('₹3.00')).toBeInTheDocument();
    expect(screen.getAllByText('₹12.50').length).toBeGreaterThan(0);
    expect(screen.getByText('Asha')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'History' })).toBeInTheDocument();
  });

  it.each([
    ['NEW', ['Accept order', 'Cancel order'], ['Start printing', 'Mark ready', 'Mark collected', 'Open document to print', 'Reprint']],
    ['ACCEPTED', ['Start printing', 'Cancel order'], ['Accept order', 'Mark ready', 'Reprint']],
    ['PRINTING', ['Open document to print', 'Confirm printed successfully'], ['Accept order', 'Cancel order', 'Mark ready', 'Reprint']],
    ['PRINTED', ['Reprint', 'Mark ready'], ['Accept order', 'Cancel order', 'Confirm printed successfully', 'Mark collected']],
    ['READY', ['Mark collected'], ['Mark ready', 'Reprint', 'Cancel order', 'Confirm printed successfully']],
    ['COLLECTED', [], ['Accept order', 'Mark collected', 'Reprint', 'Cancel order']],
    ['CANCELLED', [], ['Accept order', 'Mark collected', 'Reprint']],
    ['EXPIRED', [], ['Accept order', 'Mark collected', 'Reprint']]
  ] as [OrderStatus, string[], string[]][])('%s offers exactly the allowed actions', async (status, shown, hidden) => {
    const doc = status === 'PRINTED' || status === 'READY' ? { status: 'PRINTED_RETENTION', deleteAfter: new Date(Date.now() + 600e3).toISOString() } : {};
    mockFetch(authedSession, getDetail({ d: detail(status, doc) }));
    renderShop('/shop/orders/o1');
    await screen.findByRole('heading', { name: 'Order #CENT-1' });
    for (const s of shown) expect(btn(s)).toBeInTheDocument();
    for (const s of hidden) expect(btn(s)).not.toBeInTheDocument();
  });

  it('accepts an order via the transition API and waits for the server before updating', async () => {
    const user = userEvent.setup();
    const store = { d: detail('NEW') };
    const { calls } = mockFetch(authedSession, getDetail(store), ({ method, path, body }) => {
      if (method === 'POST' && path === '/shop/orders/o1/transitions') { store.d = detail('ACCEPTED'); return { data: { order: { id: 'o1', status: body.toStatus } } }; }
      return undefined;
    });
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Accept order' }));
    expect(await screen.findByRole('button', { name: 'Start printing' })).toBeInTheDocument();
    const post = calls.find((c) => c.path.endsWith('/transitions'))!;
    expect(post.body.toStatus).toBe('ACCEPTED');
    expect(post.body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.headers['x-csrf-token']).toBe('csrf-1');
  });

  it('cancel requires confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, getDetail({ d: detail('NEW') }), ({ method, path }) => (method === 'POST' && path.endsWith('/transitions') ? { data: { order: {} } } : undefined));
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dlg = screen.getByRole('dialog');
    expect(calls.some((c) => c.path.endsWith('/transitions'))).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Keep order' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/transitions'))?.body.toStatus).toBe('CANCELLED'));
  });

  it('opening the document never marks printed; confirmation needs an explicit click in a modal with the privacy copy', async () => {
    const user = userEvent.setup();
    const openSpy = vi.fn(() => null);
    vi.stubGlobal('open', openSpy);
    const store = { d: detail('PRINTING') };
    const deleteAfter = new Date(Date.now() + 30 * 60_000).toISOString();
    const { calls } = mockFetch(authedSession, getDetail(store), ({ method, path }) => {
      if (method === 'POST' && path.endsWith('/document-access')) return { data: { url: '/api/v1/internal/documents/k?sig=1', expiresAt: new Date(Date.now() + 300e3).toISOString(), contentDisposition: 'inline' } };
      if (method === 'POST' && path.endsWith('/print-confirmation')) {
        store.d = detail('PRINTED', { status: 'PRINTED_RETENTION', printedAt: new Date().toISOString(), deleteAfter });
        return { data: { order: { id: 'o1', status: 'PRINTED' }, document: { status: 'PRINTED_RETENTION', printedAt: new Date().toISOString(), deleteAfter } } };
      }
      return undefined;
    });
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Open document to print' }));
    expect(await screen.findByRole('link', { name: /open document in a new tab/i })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(calls.some((c) => c.path.endsWith('/print-confirmation'))).toBe(false); // opening is not confirming

    await user.click(screen.getByRole('button', { name: 'Confirm printed successfully' }));
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveTextContent(/Confirming starts a 30-minute countdown\. The customer's file will be permanently deleted at \d{1,2}:\d{2}.*\. Only confirm after the paper has actually printed\./);
    expect(calls.some((c) => c.path.endsWith('/print-confirmation'))).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.path.endsWith('/print-confirmation'))).toHaveLength(1);
    expect(await screen.findByTestId('countdown')).toHaveTextContent(/^(29|30):\d\d$/);
  });

  it('Esc closes the confirmation modal without confirming and focus starts on Cancel', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, getDetail({ d: detail('PRINTING') }));
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Confirm printed successfully' }));
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab(); await user.tab(); await user.tab(); // trap: never leaves the dialog
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/print-confirmation'))).toBe(false);
  });

  it('prevents double submit of the confirmation', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { calls } = mockFetch(authedSession, getDetail({ d: detail('PRINTING') }), ({ method, path }) => (method === 'POST' && path.endsWith('/print-confirmation') ? { data: { order: { status: 'PRINTED' }, document: {} } } : undefined));
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => { if (String(a[0]).includes('print-confirmation')) await gate; return real(...a); });
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Confirm printed successfully' }));
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' });
    await user.dblClick(confirm);
    expect(await screen.findByRole('button', { name: 'Confirming…' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.path.endsWith('/print-confirmation'))).toHaveLength(1);
  });

  it('PRINTED: shows a countdown from the server deleteAfter; reprint does not change it', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    const deleteAfter = new Date(Date.now() + 17 * 60_000 + 30_000).toISOString();
    const { calls } = mockFetch(authedSession,
      getDetail({ d: detail('PRINTED', { status: 'PRINTED_RETENTION', printedAt: new Date().toISOString(), deleteAfter }) }),
      ({ method, path }) => (method === 'POST' && path.endsWith('/document-access') ? { data: { url: '/x', expiresAt: new Date(Date.now() + 999e3).toISOString() } } : undefined));
    renderShop('/shop/orders/o1');
    const before = (await screen.findByTestId('countdown')).textContent;
    expect(before).toMatch(/^17:\d\d$/);
    expect(screen.getByText(/does not extend the deletion timer/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reprint' }));
    await screen.findByRole('link', { name: /open document in a new tab/i });
    expect(calls.filter((c) => c.path.endsWith('/document-access'))).toHaveLength(1);
    expect(screen.getByTestId('countdown').textContent).toMatch(/^17:\d\d$/);
    expect(calls.some((c) => c.path.endsWith('/print-confirmation'))).toBe(false);
  });

  it('at countdown zero disables preview/print/reprint but keeps Mark ready; refetches', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const deleteAfter = new Date(Date.now() + 3_000).toISOString();
    const store = { d: detail('PRINTED', { status: 'PRINTED_RETENTION', printedAt: new Date().toISOString(), deleteAfter }) };
    const { calls } = mockFetch(authedSession, getDetail(store));
    renderShop('/shop/orders/o1');
    expect(await screen.findByRole('button', { name: 'Reprint' })).toBeEnabled();
    const fetchesBefore = calls.filter((c) => c.path === '/shop/orders/o1').length;
    store.d = detail('PRINTED', { status: 'DELETED', printedAt: new Date().toISOString(), deleteAfter, deletedAt: new Date().toISOString() });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_500); });
    expect(screen.getByRole('button', { name: 'Reprint' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark ready' })).toBeEnabled();
    expect(screen.getByText('Document deleted.')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/shop/orders/o1').length).toBeGreaterThan(fetchesBefore);
    expect(screen.queryByTestId('countdown')).not.toBeInTheDocument();
  });

  it('server-reported DELETED document: deleted state, Mark collected still available', async () => {
    mockFetch(authedSession, getDetail({ d: detail('READY', { status: 'DELETED', printedAt: new Date(Date.now() - 3600e3).toISOString(), deleteAfter: new Date(Date.now() - 1800e3).toISOString(), deletedAt: new Date(Date.now() - 1700e3).toISOString() }) }));
    renderShop('/shop/orders/o1');
    expect(await screen.findByText('Document deleted.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark collected' })).toBeEnabled();
    expect(btn('Reprint')).not.toBeInTheDocument();
  });

  it.each([
    ['INVALID_STATUS_TRANSITION', 409, /already moved on/i],
    ['RATE_LIMITED', 429, /too many requests/i],
    ['DOCUMENT_UNAVAILABLE', 404, /no longer available/i]
  ])('handles %s with a readable banner', async (code, status, text) => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, getDetail({ d: detail('NEW') }), ({ method, path }) => (method === 'POST' && path.endsWith('/transitions') ? { status, error: { code } } : undefined));
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Accept order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    if (code === 'INVALID_STATUS_TRANSITION') expect(calls.filter((c) => c.path === '/shop/orders/o1').length).toBeGreaterThan(1); // refetched
  });

  it('shows a network error banner', async () => {
    const user = userEvent.setup();
    const { fn } = mockFetch(authedSession, getDetail({ d: detail('NEW') }));
    renderShop('/shop/orders/o1');
    const accept = await screen.findByRole('button', { name: 'Accept order' });
    fn.mockImplementation(async () => { throw new TypeError('fail'); });
    await user.click(accept);
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot reach the server/i);
  });

  it('refetches the order when a realtime event arrives', async () => {
    const store = { d: detail('NEW') };
    mockFetch(authedSession, getDetail(store));
    renderShop('/shop/orders/o1');
    await screen.findByRole('button', { name: 'Accept order' });
    store.d = detail('ACCEPTED');
    const es = FakeES.open[0]!;
    act(() => es.emit('order.statusChanged', { id: 'o1', status: 'ACCEPTED' }));
    expect(await screen.findByRole('button', { name: 'Start printing' })).toBeInTheDocument();
  });
});
