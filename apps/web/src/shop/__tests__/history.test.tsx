import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, emptyList, mockFetch, renderShop, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';
import { addDays, istYmd, presetRange, rangeError, rangeLabel, istStamp, istTimeSeconds } from '../../lib/history';
import type { HistoryItem, HistorySummary } from '../../lib/shop-api';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as { matchMedia?: unknown }).matchMedia; });

const item = (over: Partial<HistoryItem> = {}): HistoryItem => ({
  id: 'o1', orderNumber: 'CENT-4821', status: 'PRINTING', createdAt: '2026-03-10T06:14:00.000Z', originalFilename: 'Marksheet_2026.pdf',
  pageCount: 4, selectedPageCount: 4, copies: 2, colourMode: 'bw', sides: 'single', paperSize: 'A4', totalPaise: 1250,
  printInitiatedAt: '2026-03-10T06:14:09.000Z', documentStatus: 'DELETED', fileDeletedAt: '2026-03-10T06:44:09.000Z', handledBy: 'Rakesh', ...over
});
const summary = (over: Partial<HistorySummary> = {}): HistorySummary => ({
  timezone: 'Asia/Kolkata', range: { from: '2026-03-10', to: '2026-03-10' }, total: 29, printInitiated: 27, filesDeleted: 25,
  byStatus: { NEW: 0, ACCEPTED: 0, PRINTING: 27, PRINTED: 0, READY: 0, COLLECTED: 0, CANCELLED: 1, EXPIRED: 1 }, ...over
});

interface Opts { pages?: HistoryItem[][]; summary?: HistorySummary; listError?: { status: number; code: string }; moreError?: boolean }
function historyApi(o: Opts = {}): Handler[] {
  const pages = o.pages ?? [[item()]];
  let failedMore = false;
  return [
    ({ method, path }) => {
      if (method !== 'GET' || path !== '/shop/orders/history') return undefined;
      return o.listError ? { status: o.listError.status, error: { code: o.listError.code } } : undefined;
    },
    ({ method, path, query }) => {
      if (method !== 'GET' || path !== '/shop/orders/history') return undefined;
      const cursor = query.get('cursor');
      const idx = cursor ? Number(cursor) : 0;
      if (cursor && o.moreError && !failedMore) { failedMore = true; return { status: 500, error: { code: 'INTERNAL_ERROR' } }; }
      const range = { from: query.get('from')!, to: query.get('to')!, timezone: 'Asia/Kolkata' };
      return { data: { range, items: pages[idx] ?? [], nextCursor: idx + 1 < pages.length ? String(idx + 1) : undefined } };
    },
    ({ method, path }) => (method === 'GET' && path === '/shop/orders/history/summary' ? { data: o.summary ?? summary() } : undefined)
  ];
}
const listCalls = (calls: { path: string; method: string }[]) => calls.filter((c) => c.path.startsWith('/shop/orders/history') && c.method === 'GET');
const lastListQuery = (fn: ReturnType<typeof mockFetch>['fn']) => {
  const urls = fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/shop/orders/history?'));
  return new URL(urls.at(-1)!, 'http://localhost').searchParams;
};
const phone = (matches: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() })) as never;
};

describe('history helpers (Asia/Kolkata convention)', () => {
  it('computes the IST calendar day around midnight, independent of the browser timezone', () => {
    expect(istYmd(new Date('2026-03-09T18:29:59.999Z'))).toBe('2026-03-09');
    expect(istYmd(new Date('2026-03-09T18:30:00.000Z'))).toBe('2026-03-10');
  });
  it('derives presets from the IST day: today, yesterday and last 7 days (inclusive)', () => {
    const now = new Date('2026-03-10T01:00:00Z'); // 06:30 IST on 10 Mar
    expect(presetRange('today', now)).toEqual({ from: '2026-03-10', to: '2026-03-10' });
    expect(presetRange('yesterday', now)).toEqual({ from: '2026-03-09', to: '2026-03-09' });
    expect(presetRange('last7', now)).toEqual({ from: '2026-03-04', to: '2026-03-10' });
    expect(presetRange('today', new Date('2026-03-09T20:00:00Z'))).toEqual({ from: '2026-03-10', to: '2026-03-10' }); // 01:30 IST next day
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('validates custom ranges like the API: both dates, real dates, order, at most 93 days', () => {
    expect(rangeError('', '2026-03-10')).toMatch(/both/);
    expect(rangeError('2026-02-30', '2026-03-10')).toMatch(/valid/);
    expect(rangeError('2026-03-10', '2026-03-09')).toMatch(/not be before/);
    expect(rangeError('2026-01-01', '2026-06-01')).toMatch(/93/);
    expect(rangeError('2026-01-01', '2026-04-03')).toBeNull(); // exactly 93 days
    expect(rangeError('2026-03-10', '2026-03-10')).toBeNull();
  });
  it('formats times in IST and labels ranges', () => {
    expect(istStamp('2026-03-10T06:14:00.000Z', false)).toBe('11:44');
    expect(istStamp('2026-03-10T06:14:00.000Z', true)).toBe('10 Mar, 11:44');
    expect(istTimeSeconds('2026-03-10T06:44:09.000Z')).toBe('12:14:09');
    expect(rangeLabel('last7', 'a', 'b')).toBe('Last 7 days');
    expect(rangeLabel('custom', '2026-03-04', '2026-03-10')).toBe('04 Mar to 10 Mar');
    expect(rangeLabel('custom', '', '2026-03-10')).toBe('Custom range');
    expect(rangeLabel('custom', '0002-0', '2026-03-10')).toBe('Custom range');
  });
});

describe('history page', () => {
  it('shows the design columns, IST times, deletion time, print-initiated wording and the summary', async () => {
    const { fn } = mockFetch(authedSession, emptyList, ...historyApi());
    renderShop('/shop/history');
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /Order history, Today/ });
    for (const h of ['Time', 'Code', 'File', 'Pages × copies', 'Settings', 'Status', 'By', 'File deleted']) expect(within(table).getByRole('columnheader', { name: h })).toBeInTheDocument();
    // The table mounts (aria-busy) before the rows load: wait for the row instead of assuming it is already there.
    const row = await within(table).findByTestId('history-row');
    expect(within(row).getAllByText('11:44')).toHaveLength(2); // created time and the print-initiated time
    expect(within(row).getByRole('link', { name: 'Order #CENT-4821' })).toHaveAttribute('href', '/shop/orders/o1');
    expect(within(row).getByText('Marksheet_2026.pdf')).toBeInTheDocument();
    expect(within(row).getByText('4 pages')).toBeInTheDocument();
    expect(within(row).getByText('2 copies')).toBeInTheDocument();
    expect(within(row).getByText('B&W')).toBeInTheDocument();
    expect(within(row).getByText('Single-sided')).toBeInTheDocument();
    expect(within(row).getByText('Print started')).toBeInTheDocument();
    expect(within(row).getByTestId('print-initiated')).toHaveTextContent('Print initiated 11:44');
    expect(within(row).getByText('Rakesh')).toBeInTheDocument();
    expect(within(row).getByText('12:14:09')).toBeInTheDocument();
    const stats = screen.getByLabelText(/Summary for Today/);
    expect(within(stats).getByText('29')).toBeInTheDocument();
    expect(within(stats).getByText('27')).toBeInTheDocument();
    // today's IST range is what was requested
    const q = lastListQuery(fn);
    expect(q.get('from')).toBe(istYmd()); expect(q.get('to')).toBe(istYmd()); expect(q.get('limit')).toBe('25');
    // honest wording: never claims paper was printed, no file actions, no revenue
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\bPrinted\b|revenue/i);
    expect(screen.queryByRole('button', { name: /print|reprint|save file|download/i })).toBeNull();
    expect(screen.getByText(/never opens, downloads or reprints files/)).toBeInTheDocument();
  });

  it('is listed in the sidebar, keeps Analytics, and links to it from the page', async () => {
    mockFetch(authedSession, emptyList, ...historyApi());
    renderShop('/shop/history');
    await screen.findByRole('heading', { name: 'History' });
    const nav = screen.getByRole('navigation', { name: 'Shop sections' });
    expect(within(nav).getByRole('link', { name: 'History' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View analytics' })).toHaveAttribute('href', '/shop/analytics');
  });

  it('switches date presets and requests the matching IST range', async () => {
    const user = userEvent.setup();
    const { fn } = mockFetch(authedSession, emptyList, ...historyApi());
    renderShop('/shop/history');
    await screen.findByTestId('history-row');
    await user.click(screen.getByRole('radio', { name: 'Yesterday' }));
    await waitFor(() => expect(lastListQuery(fn).get('from')).toBe(presetRange('yesterday').from));
    expect(lastListQuery(fn).get('to')).toBe(presetRange('yesterday').to);
    await user.click(screen.getByRole('radio', { name: 'Last 7 days' }));
    await waitFor(() => expect(lastListQuery(fn).get('from')).toBe(presetRange('last7').from));
    expect(lastListQuery(fn).get('to')).toBe(presetRange('last7').to);
    expect(await screen.findByRole('table', { name: /Last 7 days/ })).toBeInTheDocument();
    // multi-day ranges show the date with the time
    expect(screen.getByText('10 Mar, 11:44')).toBeInTheDocument();
  });

  it('custom range: validates before calling the API, disables export while invalid, then loads', async () => {
    const user = userEvent.setup();
    const { fn } = mockFetch(authedSession, emptyList, ...historyApi());
    renderShop('/shop/history');
    await screen.findByTestId('history-row');
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    const from = screen.getByLabelText('From'), to = screen.getByLabelText('To');
    await user.clear(from); // empty
    expect(await screen.findByText(/Choose both a start and an end date/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    expect(screen.queryByRole('table')).toBeNull();
    await user.type(from, '2026-03-10'); await user.clear(to); await user.type(to, '2026-03-05');
    expect(await screen.findAllByText(/must not be before/)).not.toHaveLength(0);
    await user.clear(to); await user.type(to, '2026-03-11');
    await waitFor(() => { const q = lastListQuery(fn); expect(q.get('from')).toBe('2026-03-10'); expect(q.get('to')).toBe('2026-03-11'); });
    expect(await screen.findByRole('table', { name: /10 Mar to 11 Mar/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('never sends an invalid custom range to the API', async () => {
    const user = userEvent.setup();
    const { fn } = mockFetch(authedSession, emptyList, ...historyApi());
    renderShop('/shop/history');
    await screen.findByTestId('history-row');
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    await user.clear(screen.getByLabelText('From'));
    await screen.findByText(/Choose both/);
    const urls = fn.mock.calls.map((c) => new URL(String(c[0]), 'http://x'));
    for (const u of urls.filter((u) => u.pathname.includes('/shop/orders/history'))) {
      expect(u.searchParams.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(u.searchParams.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('filters by status and by debounced search on job code or file name', async () => {
    const user = userEvent.setup();
    const { fn } = mockFetch(authedSession, emptyList, ...historyApi());
    renderShop('/shop/history');
    await screen.findByTestId('history-row');
    await user.selectOptions(screen.getByLabelText('Status'), 'Cancelled');
    await waitFor(() => expect(lastListQuery(fn).get('status')).toBe('CANCELLED'));
    await user.selectOptions(screen.getByLabelText('Status'), 'Print started');
    await waitFor(() => expect(lastListQuery(fn).get('status')).toBe('ACCEPTED,PRINTING'));
    const before = fn.mock.calls.length;
    await user.type(screen.getByRole('searchbox', { name: 'Code or file name' }), '  4821 ');
    expect(fn.mock.calls.length).toBe(before); // debounced: nothing yet
    await waitFor(() => expect(lastListQuery(fn).get('q')).toBe('4821'));
    expect(lastListQuery(fn).get('status')).toBe('ACCEPTED,PRINTING');
    // the summary uses the same filters
    const sumUrl = fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/history/summary')).at(-1)!;
    expect(new URL(sumUrl, 'http://x').searchParams.get('q')).toBe('4821');
  });

  it('paginates with Load more using the cursor, without duplicating rows', async () => {
    const user = userEvent.setup();
    const { fn } = mockFetch(authedSession, emptyList, ...historyApi({ pages: [[item({ id: 'a', orderNumber: 'C-1' }), item({ id: 'b', orderNumber: 'C-2' })], [item({ id: 'b', orderNumber: 'C-2' }), item({ id: 'c', orderNumber: 'C-3' })]] }));
    renderShop('/shop/history');
    expect(await screen.findAllByTestId('history-row')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByTestId('history-row')).toHaveLength(3));
    expect(lastListQuery(fn).get('cursor')).toBe('1');
    expect(screen.getByText('End of results')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByText('Showing 3')).toBeInTheDocument();
  });

  it('keeps loaded rows and offers Retry when a later page fails', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, ...historyApi({ pages: [[item({ id: 'a' })], [item({ id: 'z', orderNumber: 'C-9' })]], moreError: true }));
    renderShop('/shop/history');
    await screen.findByTestId('history-row');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/server had a problem/i);
    expect(screen.getAllByTestId('history-row')).toHaveLength(1);
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getAllByTestId('history-row')).toHaveLength(2));
  });

  it('shows a loading state, then an empty state with Clear filters when filters match nothing', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, ...historyApi({ pages: [[]] }));
    renderShop('/shop/history');
    expect(await screen.findByRole('heading', { name: 'No orders today' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'Expired');
    expect(await screen.findByRole('heading', { name: 'No orders match these filters' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('heading', { name: 'No orders today' })).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toHaveValue('');
  });

  it('announces loading while the table is busy', async () => {
    mockFetch(authedSession, emptyList, ...historyApi());
    renderShop('/shop/history');
    expect(await screen.findAllByText('Loading history')).not.toHaveLength(0);
    await screen.findByTestId('history-row');
    expect(screen.getByText('1 order shown')).toBeInTheDocument();
  });

  it('shows an error with Retry that reloads the list', async () => {
    const user = userEvent.setup();
    let fail = true;
    const { calls } = mockFetch(authedSession, emptyList,
      ({ method, path }) => (fail && method === 'GET' && path.startsWith('/shop/orders/history') ? { status: 500, error: { code: 'INTERNAL_ERROR' } } : undefined),
      ...historyApi());
    renderShop('/shop/history');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/server had a problem/i);
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    fail = false;
    const before = listCalls(calls).length;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('history-row')).toBeInTheDocument();
    expect(listCalls(calls).length).toBeGreaterThan(before);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders cards instead of a table on phones, with the same facts', async () => {
    phone(true);
    mockFetch(authedSession, emptyList, ...historyApi());
    renderShop('/shop/history');
    const list = await screen.findByRole('list', { name: /Order history, Today/ });
    expect(screen.queryByRole('table')).toBeNull();
    const card = within(list).getByTestId('history-row');
    expect(within(card).getByRole('link', { name: 'Order #CENT-4821' })).toBeInTheDocument();
    expect(within(card).getByText('Marksheet_2026.pdf')).toBeInTheDocument();
    expect(within(card).getByText('Rakesh')).toBeInTheDocument();
    expect(within(card).getByText('12:14:09')).toBeInTheDocument();
    expect(within(card).getByText('₹12.50')).toBeInTheDocument();
  });

  it('shows words, not promises, for files that are not deleted yet', async () => {
    mockFetch(authedSession, emptyList, ...historyApi({ pages: [[item({ documentStatus: 'AVAILABLE', fileDeletedAt: null, printInitiatedAt: null, handledBy: null, status: 'NEW' })]] }));
    renderShop('/shop/history');
    const row = await screen.findByTestId('history-row');
    expect(within(row).getByText('Not yet')).toBeInTheDocument();
    expect(within(row).queryByTestId('print-initiated')).toBeNull();
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  describe('CSV export', () => {
    it('downloads the CSV for the current filters and says it holds metadata only', async () => {
      const user = userEvent.setup();
      const { fn } = mockFetch(authedSession, emptyList, ...historyApi());
      const base = fn.getMockImplementation()!;
      fn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/history/export.csv')) {
          return new Response('﻿"Job code"\r\n', { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="order-history-2026-03-10_to_2026-03-10.csv"', 'x-export-truncated': 'false' } });
        }
        return base(input, init);
      });
      const create = vi.fn(() => 'blob:csv'); const revoke = vi.fn();
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      renderShop('/shop/history');
      await screen.findByTestId('history-row');
      await user.selectOptions(screen.getByLabelText('Status'), 'Cancelled');
      await waitFor(() => expect(lastListQuery(fn).get('status')).toBe('CANCELLED'));
      await user.click(screen.getByRole('button', { name: 'Export CSV' }));
      expect(await screen.findByText(/Exported order-history-2026-03-10_to_2026-03-10\.csv/)).toBeInTheDocument();
      expect(screen.getByText(/order details only, never file contents/)).toBeInTheDocument();
      const exportUrl = fn.mock.calls.map((c) => String(c[0])).find((u) => u.includes('export.csv'))!;
      const p = new URL(exportUrl, 'http://x').searchParams;
      expect(p.get('status')).toBe('CANCELLED'); expect(p.get('from')).toBe(istYmd());
      expect(p.has('cursor')).toBe(false); expect(p.has('limit')).toBe(false);
      expect(create).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledTimes(1);
      click.mockRestore();
    });

    it('explains a truncated export', async () => {
      const user = userEvent.setup();
      const { fn } = mockFetch(authedSession, emptyList, ...historyApi());
      const base = fn.getMockImplementation()!;
      fn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes('export.csv')
          ? new Response('x', { status: 200, headers: { 'content-disposition': 'attachment; filename="h.csv"', 'x-export-truncated': 'true' } })
          : base(input, init));
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      renderShop('/shop/history');
      await screen.findByTestId('history-row');
      await user.click(screen.getByRole('button', { name: 'Export CSV' }));
      expect(await screen.findByText(/limited to the first 5,000 rows/)).toBeInTheDocument();
    });

    it.each([[429, 'RATE_LIMITED', /Too many requests/], [403, 'FORBIDDEN', /do not have permission/], [500, 'INTERNAL_ERROR', /server had a problem/]])(
      'shows a readable error when the export fails (%s)', async (status, code, text) => {
        const user = userEvent.setup();
        const { fn } = mockFetch(authedSession, emptyList, ...historyApi());
        const base = fn.getMockImplementation()!;
        fn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
          String(input).includes('export.csv') ? new Response(JSON.stringify({ error: { code, message: 'x', requestId: 'r' } }), { status }) : base(input, init));
        const create = vi.fn(); Object.assign(URL, { createObjectURL: create });
        renderShop('/shop/history');
        await screen.findByTestId('history-row');
        await user.click(screen.getByRole('button', { name: 'Export CSV' }));
        expect(await screen.findByText(text)).toBeInTheDocument();
        expect(create).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
      });
  });
});
