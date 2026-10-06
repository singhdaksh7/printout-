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
    document: { id: 'd1', status: 'AVAILABLE', pageCount: 10, uploadedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), printedAt: null, printInitiatedAt: null, deleteAfter: null, deletedAt: null, deletionState: 'OK', ...doc },
    priceSnapshot: { selectedPageCount: 4, sheetsPerCopy: 2, totalSheets: 4, unitPricePaise: 300, totalPaise: 1250, currency: 'INR' },
    printOptionsSnapshot: { paperSize: 'A4', colourMode: 'bw', sides: 'duplex', copies: 2, pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 3 }, { from: 7, to: 7 }] } },
    statusHistory: [{ toStatus: 'NEW', createdAt: new Date().toISOString() }]
  };
}
const inWindow = (extra: Partial<OrderDetail['document']> = {}) => ({ status: 'PRINTED_RETENTION', deleteAfter: new Date(Date.now() + 600e3).toISOString(), ...extra });
const getDetail = (store: { d: OrderDetail }): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/orders/o1' ? { data: store.d } : undefined);
const btn = (name: RegExp | string) => screen.queryByRole('button', { name });
/** Every lifecycle control the shopkeeper must never need. */
const HIDDEN_ALWAYS = ['Accept only', 'Accept order', 'Start printing', 'Confirm printed successfully', 'Mark printed', 'Mark ready', 'Mark collected', 'Reopen document'];

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
    // [label, status, document, shown, hidden-in-addition-to-the-always-hidden]
    ['new request', 'NEW', {}, ['Print', 'Save file', 'Cancel order'], ['Reprint']],
    ['legacy ACCEPTED, never printed', 'ACCEPTED', {}, ['Print', 'Save file'], ['Reprint', 'Cancel order']],
    ['legacy PRINTING, never printed (24h rule)', 'PRINTING', {}, ['Print', 'Save file'], ['Reprint', 'Cancel order']],
    ['print started, inside the window', 'PRINTING', inWindow({ printInitiatedAt: new Date().toISOString() }), ['Reprint', 'Save file'], ['Print', 'Cancel order']],
    ['legacy confirmed PRINTED, inside the window', 'PRINTED', inWindow({ printedAt: new Date().toISOString() }), ['Reprint', 'Save file'], ['Print', 'Cancel order']],
    ['legacy READY, inside the window', 'READY', inWindow({ printedAt: new Date().toISOString() }), ['Reprint', 'Save file'], ['Print']],
    ['legacy COLLECTED, file deleted', 'COLLECTED', { status: 'DELETED', deletedAt: new Date().toISOString() }, [], ['Print', 'Reprint', 'Save file', 'Cancel order']],
    ['CANCELLED', 'CANCELLED', {}, [], ['Print', 'Reprint', 'Save file', 'Cancel order']],
    ['EXPIRED', 'EXPIRED', {}, [], ['Print', 'Reprint', 'Save file', 'Cancel order']]
  ] as [string, OrderStatus, Partial<OrderDetail['document']>, string[], string[]][])('%s offers exactly the allowed actions', async (_label, status, doc, shown, hidden) => {
    mockFetch(authedSession, getDetail({ d: detail(status, doc) }));
    renderShop('/shop/orders/o1');
    await screen.findByRole('heading', { name: 'Order #CENT-1' });
    for (const s of shown) expect(btn(new RegExp(`^${s}$`))).toBeInTheDocument();
    for (const s of [...hidden, ...HIDDEN_ALWAYS]) expect(btn(new RegExp(`^${s}$`))).not.toBeInTheDocument();
  });

  it('cancel requires confirmation (only offered for a request nobody printed)', async () => {
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

  it('before Print the page says the 30-minute countdown starts on Print; opening the page itself starts nothing', async () => {
    const { calls } = mockFetch(authedSession, getDetail({ d: detail('NEW') }));
    renderShop('/shop/orders/o1');
    await screen.findByRole('button', { name: 'Print' });
    expect(screen.getByText(/starts a 30-minute countdown/i)).toBeInTheDocument();
    expect(screen.getByText('Expires if not printed')).toBeInTheDocument();
    expect(screen.queryByTestId('countdown')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('after Print: countdown from the server deleteAfter, "Print started" row, and Reprint does not change it', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    const deleteAfter = new Date(Date.now() + 17 * 60_000 + 30_000).toISOString();
    const { calls } = mockFetch(authedSession,
      getDetail({ d: detail('PRINTING', { status: 'PRINTED_RETENTION', printInitiatedAt: new Date().toISOString(), deleteAfter }) }),
      ({ method, path }) => (method === 'POST' && path.endsWith('/print-now')
        ? { data: { order: { id: 'o1', orderNumber: 'CENT-1', status: 'PRINTING' }, transitioned: false, firstPrint: false, document: { status: 'PRINTED_RETENTION', printInitiatedAt: null, deleteAfter }, access: { url: '/x', expiresAt: new Date(Date.now() + 999e3).toISOString() } } }
        : undefined));
    renderShop('/shop/orders/o1');
    expect((await screen.findByTestId('countdown')).textContent).toMatch(/^17:\d\d$/);
    expect(screen.getByText('Print started', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.getByText(/does not extend the deletion timer/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reprint' }));
    await screen.findByRole('link', { name: /open document in a new tab/i });
    expect(calls.filter((c) => c.path.endsWith('/print-now'))).toHaveLength(1);
    expect(screen.getByTestId('countdown').textContent).toMatch(/^17:\d\d$/);
    expect(calls.some((c) => c.path.endsWith('/print-confirmation'))).toBe(false);
  });

  it('at countdown zero: no Print/Reprint/Save left, "file deleted" explanation, refetches until the server says DELETED', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const deleteAfter = new Date(Date.now() + 3_000).toISOString();
    const store = { d: detail('PRINTING', { status: 'PRINTED_RETENTION', printInitiatedAt: new Date().toISOString(), deleteAfter }) };
    const { calls } = mockFetch(authedSession, getDetail(store));
    renderShop('/shop/orders/o1');
    expect(await screen.findByRole('button', { name: 'Reprint' })).toBeEnabled();
    const fetchesBefore = calls.filter((c) => c.path === '/shop/orders/o1').length;
    store.d = detail('PRINTING', { status: 'DELETED', printInitiatedAt: new Date().toISOString(), deleteAfter, deletedAt: new Date().toISOString() });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_500); });
    expect(screen.queryByRole('button', { name: /print|reprint|save file/i })).not.toBeInTheDocument();
    expect(screen.getByText('Document deleted.')).toBeInTheDocument();
    expect(screen.getByText(/can no longer be printed or saved/i)).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/shop/orders/o1').length).toBeGreaterThan(fetchesBefore);
    expect(screen.queryByTestId('countdown')).not.toBeInTheDocument();
  });

  it.each([
    ['INVALID_STATUS_TRANSITION', 409, /already moved on/i],
    ['RATE_LIMITED', 429, /too many requests/i],
    ['DOCUMENT_UNAVAILABLE', 404, /no longer available/i]
  ])('handles %s from Print with a readable banner', async (code, status, text) => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    const { calls } = mockFetch(authedSession, getDetail({ d: detail('NEW') }), ({ method, path }) => (method === 'POST' && path.endsWith('/print-now') ? { status, error: { code } } : undefined));
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Print' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    if (code === 'INVALID_STATUS_TRANSITION') expect(calls.filter((c) => c.path === '/shop/orders/o1').length).toBeGreaterThan(1); // refetched
  });

  it('shows a network error banner', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    const { fn } = mockFetch(authedSession, getDetail({ d: detail('NEW') }));
    renderShop('/shop/orders/o1');
    const print = await screen.findByRole('button', { name: 'Print' });
    fn.mockImplementation(async () => { throw new TypeError('fail'); });
    await user.click(print);
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot reach the server/i);
  });

  it('refetches the order when a realtime event arrives (Print here -> Reprint on another device)', async () => {
    const store = { d: detail('NEW') };
    mockFetch(authedSession, getDetail(store));
    renderShop('/shop/orders/o1');
    await screen.findByRole('button', { name: 'Print' });
    store.d = detail('PRINTING', { status: 'PRINTED_RETENTION', printInitiatedAt: new Date().toISOString(), deleteAfter: new Date(Date.now() + 600e3).toISOString() });
    const es = FakeES.open[0]!;
    act(() => es.emit('order.statusChanged', { id: 'o1', status: 'PRINTING' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Print' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Reprint' })).toBeInTheDocument();
  });
});
