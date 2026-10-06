import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, mockFetch, order, renderShop, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';
import type { OrderDetail, OrderStatus, OrderSummary } from '../../lib/shop-api';
import { SAVE_FILE_NOTE } from '../print-actions';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const access = () => ({ url: '/api/v1/internal/documents/k?exp=1&sig=1', expiresAt: new Date(Date.now() + 300e3).toISOString(), contentDisposition: 'inline' });
const deleteAfter = () => new Date(Date.now() + 30 * 60_000).toISOString();
function detail(status: OrderStatus, doc: Partial<OrderDetail['document']> = {}): OrderDetail {
  return {
    order: { ...order({ status }), originalFilename: 'thesis-final.pdf' },
    document: { id: 'd1', status: 'AVAILABLE', pageCount: 10, uploadedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), printedAt: null, printInitiatedAt: null, deleteAfter: null, deletedAt: null, deletionState: 'OK', ...doc },
    priceSnapshot: { selectedPageCount: 4, totalPaise: 1250 }, printOptionsSnapshot: { paperSize: 'A4', colourMode: 'bw', sides: 'duplex', copies: 2, pageSelection: { mode: 'all' } },
    statusHistory: [{ toStatus: 'NEW', createdAt: new Date().toISOString() }]
  } as OrderDetail;
}
/** The detail the server returns once the first Print succeeded. */
const printedDetail = () => detail('PRINTING', { status: 'PRINTED_RETENTION', printInitiatedAt: new Date().toISOString(), deleteAfter: deleteAfter() });
const printResponse = (first: boolean) => ({
  data: {
    order: { id: 'o1', orderNumber: 'CENT-1', status: 'PRINTING' }, transitioned: first, firstPrint: first,
    document: { status: 'PRINTED_RETENTION', printInitiatedAt: new Date().toISOString(), deleteAfter: deleteAfter() }, access: access()
  }
});
const getDetail = (store: { d: OrderDetail }): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/orders/o1' ? { data: store.d } : undefined);
const listOf = (items: OrderSummary[]): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/orders' ? { data: { items } } : undefined);

describe('Print (one primary action)', () => {
  it('detail: Print calls ONE print-now request (no accept/start/confirm), opens the viewer, then offers Reprint', async () => {
    const user = userEvent.setup();
    const open = vi.fn(() => ({ location: { href: '' }, close: vi.fn(), opener: null }));
    vi.stubGlobal('open', open);
    const store = { d: detail('NEW') };
    const { calls } = mockFetch(authedSession, getDetail(store), ({ method, path }) => {
      if (method === 'POST' && path === '/shop/orders/o1/print-now') { store.d = printedDetail(); return printResponse(true); }
      return undefined;
    });
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Print' }));
    expect(await screen.findByRole('button', { name: 'Reprint' })).toBeInTheDocument();
    const post = calls.filter((c) => c.method === 'POST');
    expect(post.map((c) => c.path)).toEqual(['/shop/orders/o1/print-now']);
    expect(post[0]!.body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(post[0]!.headers['x-csrf-token']).toBe('csrf-1');
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.path.endsWith('/print-confirmation') || c.path.endsWith('/transitions'))).toBe(false);
    expect(await screen.findByTestId('countdown')).toHaveTextContent(/^(29|30):\d\d$/);
    expect(screen.queryByRole('button', { name: /confirm|accept|start printing|mark/i })).not.toBeInTheDocument();
  });

  it('detail: the button is disabled while the request runs, so a double click sends one request', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const store = { d: detail('NEW') };
    const { calls } = mockFetch(authedSession, getDetail(store), ({ method, path }) => {
      if (method === 'POST' && path.endsWith('/print-now')) { store.d = printedDetail(); return printResponse(true); }
      return undefined;
    });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => { if (String(a[0]).includes('print-now')) await gate; return real(...a); });
    renderShop('/shop/orders/o1');
    await user.dblClick(await screen.findByRole('button', { name: 'Print' }));
    expect(await screen.findByRole('button', { name: 'Opening…' })).toBeDisabled();
    release();
    await screen.findByRole('button', { name: 'Reprint' });
    expect(calls.filter((c) => c.path.endsWith('/print-now'))).toHaveLength(1);
  });

  it('detail: a refusal (document gone) shows a readable error, closes the blank tab and starts no countdown', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    vi.stubGlobal('open', vi.fn(() => ({ location: { href: '' }, close, opener: null })));
    mockFetch(authedSession, getDetail({ d: detail('NEW') }), ({ method, path }) =>
      method === 'POST' && path.endsWith('/print-now') ? { status: 409, error: { code: 'DOCUMENT_UNAVAILABLE', message: 'gone' } } : undefined);
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Print' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(close).toHaveBeenCalled();
    expect(screen.queryByTestId('countdown')).not.toBeInTheDocument();
  });

  it('detail: Reprint is the same single request and does not change the displayed deadline', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    const store = { d: printedDetail() };
    const { calls } = mockFetch(authedSession, getDetail(store), ({ method, path }) => (method === 'POST' && path.endsWith('/print-now') ? printResponse(false) : undefined));
    renderShop('/shop/orders/o1');
    const before = (await screen.findByText(/Scheduled deletion/)).nextSibling?.textContent;
    await user.click(await screen.findByRole('button', { name: 'Reprint' }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/print-now'))).toHaveLength(1));
    expect(screen.getByText(/Scheduled deletion/).nextSibling?.textContent).toBe(before);
    expect(calls.some((c) => c.path.endsWith('/print-confirmation'))).toBe(false);
  });

  it('queue: a New card has a dominant Print, a secondary Save file and View; one click = one request', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    const { calls } = mockFetch(authedSession, listOf([order()]), ({ method, path }) =>
      method === 'POST' && path === '/shop/orders/o1/print-now' ? printResponse(true) : undefined);
    renderShop('/shop');
    const card = within(await screen.findByTestId('order-card'));
    const pn = card.getByRole('button', { name: 'Print' });
    expect(pn.className).toContain('sh-btn-primary');
    expect(card.getByRole('button', { name: 'Save file' }).className).not.toContain('sh-btn-primary');
    expect(card.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/shop/orders/o1');
    expect(card.queryByRole('button', { name: /accept|start printing/i })).not.toBeInTheDocument();
    await user.click(pn);
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/print-now'))).toHaveLength(1));
  });

  it('queue: a print-initiated card inside its window shows Reprint + remaining time and never a lifecycle button', async () => {
    mockFetch(authedSession, listOf([order({ status: 'PRINTING', documentStatus: 'PRINTED_RETENTION', printInitiatedAt: new Date().toISOString(), deleteAfter: new Date(Date.now() + 26.5 * 60_000).toISOString() })]));
    renderShop('/shop');
    const card = within(await screen.findByTestId('order-card'));
    expect(card.getByRole('button', { name: 'Reprint' }).className).toContain('sh-btn-primary');
    expect(card.getByTestId('reprint-window')).toHaveTextContent('Available for reprint for 27 min');
    expect(card.queryByRole('button', { name: 'Print' })).not.toBeInTheDocument();
    expect(card.queryByRole('button', { name: /confirm|ready|collected|accept/i })).not.toBeInTheDocument();
  });

  it('queue: cards whose document is gone or whose order is cancelled offer no Print / Reprint / Save file', async () => {
    mockFetch(authedSession, listOf([
      order({ id: 'a', orderNumber: 'A-1', documentStatus: 'DELETED' }),
      order({ id: 'b', orderNumber: 'B-1', status: 'CANCELLED' }),
      order({ id: 'c', orderNumber: 'C-1', status: 'PRINTING', printInitiatedAt: new Date().toISOString(), documentStatus: 'PRINTED_RETENTION', deleteAfter: new Date(Date.now() - 1000).toISOString() })
    ]));
    renderShop('/shop');
    const cards = await screen.findAllByTestId('order-card');
    for (const c of cards) expect(within(c).queryByRole('button', { name: /print|reprint|save file/i })).not.toBeInTheDocument();
  });
});

describe('Save file (explicit download)', () => {
  it('detail: Save file requests an attachment link, triggers a download with the original filename, never prints or transitions', async () => {
    const user = userEvent.setup();
    const clicks: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push({ href: this.getAttribute('href') ?? '', download: this.download }); });
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const { calls } = mockFetch(authedSession, getDetail({ d: detail('NEW') }), ({ method, path }) =>
      method === 'POST' && path === '/shop/orders/o1/document-download'
        ? { data: { url: '/api/v1/internal/documents/k?exp=1&dl=1&sig=1', expiresAt: new Date(Date.now() + 300e3).toISOString(), contentDisposition: 'attachment', fileName: 'thesis-final.pdf' } }
        : undefined);
    renderShop('/shop/orders/o1');
    expect(await screen.findAllByText(SAVE_FILE_NOTE, { exact: false })).not.toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'Save file' }));
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0]).toEqual({ href: '/api/v1/internal/documents/k?exp=1&dl=1&sig=1', download: 'thesis-final.pdf' });
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/shop/orders/o1/document-download']); // no print-now: Save never starts retention
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('Print never triggers a download', async () => {
    const user = userEvent.setup();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('open', vi.fn(() => null));
    const store = { d: detail('NEW') };
    const { calls } = mockFetch(authedSession, getDetail(store), ({ method, path }) => {
      if (method === 'POST' && path.endsWith('/print-now')) { store.d = printedDetail(); return printResponse(true); }
      return undefined;
    });
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Print' }));
    await screen.findByRole('button', { name: 'Reprint' });
    expect(anchorClick).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path.endsWith('/document-download'))).toBe(false);
  });

  it('a refused download (expired/deleted) shows an error and downloads nothing', async () => {
    const user = userEvent.setup();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mockFetch(authedSession, getDetail({ d: detail('NEW') }), ({ method, path }) =>
      method === 'POST' && path.endsWith('/document-download') ? { status: 410, error: { code: 'DOCUMENT_UNAVAILABLE', message: 'gone' } } : undefined);
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Save file' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(anchorClick).not.toHaveBeenCalled();
  });
});
