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
function detail(status: OrderStatus): OrderDetail {
  return {
    order: { ...order({ status }), originalFilename: 'thesis-final.pdf' },
    document: { id: 'd1', status: 'AVAILABLE', pageCount: 10, uploadedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), printedAt: null, deleteAfter: null, deletedAt: null, deletionState: 'OK' },
    priceSnapshot: { selectedPageCount: 4, totalPaise: 1250 }, printOptionsSnapshot: { paperSize: 'A4', colourMode: 'bw', sides: 'duplex', copies: 2, pageSelection: { mode: 'all' } },
    statusHistory: [{ toStatus: 'NEW', createdAt: new Date().toISOString() }]
  } as OrderDetail;
}
const getDetail = (store: { d: OrderDetail }): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/orders/o1' ? { data: store.d } : undefined);
const listOf = (items: OrderSummary[]): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/orders' ? { data: { items } } : undefined);

describe('Print Now (one primary action)', () => {
  it('detail: Print now calls ONE print-now request (no separate accept/start), opens the viewer, never confirms printing', async () => {
    const user = userEvent.setup();
    const open = vi.fn(() => ({ location: { href: '' }, close: vi.fn(), opener: null }));
    vi.stubGlobal('open', open);
    const store = { d: detail('NEW') };
    const { calls } = mockFetch(authedSession, getDetail(store), ({ method, path }) => {
      if (method === 'POST' && path === '/shop/orders/o1/print-now') {
        store.d = detail('PRINTING');
        return { data: { order: { id: 'o1', orderNumber: 'CENT-1', status: 'PRINTING' }, transitioned: true, access: access() } };
      }
      return undefined;
    });
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Print now' }));
    expect(await screen.findByRole('button', { name: 'Reopen document' })).toBeInTheDocument();
    const post = calls.filter((c) => c.method === 'POST');
    expect(post.map((c) => c.path)).toEqual(['/shop/orders/o1/print-now']);
    expect(post[0]!.body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(post[0]!.headers['x-csrf-token']).toBe('csrf-1');
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.path.endsWith('/print-confirmation') || c.path.endsWith('/transitions'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Confirm printed successfully' })).toBeInTheDocument(); // still needs the explicit confirmation
  });

  it('detail: the button is disabled while the request runs, so a double click sends one request', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const store = { d: detail('NEW') };
    const { calls } = mockFetch(authedSession, getDetail(store), ({ method, path }) => {
      if (method === 'POST' && path.endsWith('/print-now')) { store.d = detail('PRINTING'); return { data: { order: { id: 'o1', orderNumber: 'CENT-1', status: 'PRINTING' }, transitioned: true, access: access() } }; }
      return undefined;
    });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => { if (String(a[0]).includes('print-now')) await gate; return real(...a); });
    renderShop('/shop/orders/o1');
    const b = await screen.findByRole('button', { name: 'Print now' });
    await user.dblClick(b);
    expect(await screen.findByRole('button', { name: 'Opening…' })).toBeDisabled();
    release();
    await screen.findByRole('button', { name: 'Reopen document' });
    expect(calls.filter((c) => c.path.endsWith('/print-now'))).toHaveLength(1);
  });

  it('detail: a refusal (document gone) shows a readable error and does not pretend it printed', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    vi.stubGlobal('open', vi.fn(() => ({ location: { href: '' }, close, opener: null })));
    mockFetch(authedSession, getDetail({ d: detail('NEW') }), ({ method, path }) =>
      method === 'POST' && path.endsWith('/print-now') ? { status: 409, error: { code: 'DOCUMENT_UNAVAILABLE', message: 'gone' } } : undefined);
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Print now' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(close).toHaveBeenCalled(); // the blank viewer tab is closed again
    expect(screen.queryByRole('button', { name: 'Confirm printed successfully' })).not.toBeInTheDocument();
  });

  it('queue: a NEW card has a dominant Print Now, a secondary Save file and View details; one click = one request', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    const { calls } = mockFetch(authedSession, listOf([order()]), ({ method, path }) =>
      method === 'POST' && path === '/shop/orders/o1/print-now' ? { data: { order: { id: 'o1', orderNumber: 'CENT-1', status: 'PRINTING' }, transitioned: true, access: access() } } : undefined);
    renderShop('/shop');
    const card = within(await screen.findByTestId('order-card'));
    const pn = card.getByRole('button', { name: 'Print Now' });
    expect(pn.className).toContain('sh-btn-primary');
    expect(card.getByRole('button', { name: 'Save file' }).className).not.toContain('sh-btn-primary');
    expect(card.getByRole('link', { name: 'View details' })).toHaveAttribute('href', '/shop/orders/o1');
    expect(card.queryByRole('button', { name: /accept|start printing/i })).not.toBeInTheDocument();
    await user.click(pn);
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/print-now'))).toHaveLength(1));
  });

  it('queue: cards whose document is gone or whose order is finished offer no Print Now / Save file', async () => {
    mockFetch(authedSession, listOf([
      order({ id: 'a', orderNumber: 'A-1', documentStatus: 'DELETED' }),
      order({ id: 'b', orderNumber: 'B-1', status: 'READY', documentStatus: 'PRINTED_RETENTION' }),
      order({ id: 'c', orderNumber: 'C-1', status: 'PRINTING' })
    ]));
    renderShop('/shop');
    const cards = await screen.findAllByTestId('order-card');
    expect(within(cards[0]!).queryByRole('button', { name: /print now|save file/i })).not.toBeInTheDocument();
    expect(within(cards[1]!).queryByRole('button', { name: /print now|save file/i })).not.toBeInTheDocument();
    expect(within(cards[2]!).getByRole('button', { name: 'Reopen document' })).toBeInTheDocument(); // PRINTING: reopen only
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
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/shop/orders/o1/document-download']);
    expect(open).not.toHaveBeenCalled(); // no viewer tab, no print
    expect(document.querySelector('a[download]')).toBeNull(); // temporary anchor removed
  });

  it('Print Now never triggers a download', async () => {
    const user = userEvent.setup();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('open', vi.fn(() => null));
    const store = { d: detail('NEW') };
    const { calls } = mockFetch(authedSession, getDetail(store), ({ method, path }) => {
      if (method === 'POST' && path.endsWith('/print-now')) { store.d = detail('PRINTING'); return { data: { order: { id: 'o1', orderNumber: 'CENT-1', status: 'PRINTING' }, transitioned: true, access: access() } }; }
      return undefined;
    });
    renderShop('/shop/orders/o1');
    await user.click(await screen.findByRole('button', { name: 'Print now' }));
    await screen.findByRole('button', { name: 'Reopen document' });
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
