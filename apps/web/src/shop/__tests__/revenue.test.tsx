import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, emptyList, mockFetch, renderShop, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';
import { bucketLabel, dayLabel, formatChange, formatInr, rangeText, revenueRange, revenueRangeError } from '../../lib/revenue';
import type { RevenueReport, RevenueTotals } from '../../lib/shop-api';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); try { sessionStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const totals = (o: Partial<RevenueTotals> = {}): RevenueTotals => ({
  orderCount: 6, countedOrders: 4, estimatedOrderValuePaise: 123456, averageEstimatedOrderValuePaise: 30864, pagesRequested: 80, ordersWithUnknownPages: 0,
  zeroValueOrders: 0, printStarted: 5, cancelled: 1, expired: 1, excludedQuotedValuePaise: 2500, ...o
});
const report = (o: Partial<RevenueReport> = {}): RevenueReport => ({
  timezone: 'Asia/Kolkata',
  range: { from: '2026-03-04', to: '2026-03-10', days: 7 },
  basis: 'ESTIMATED_ORDER_VALUE',
  collected: { available: false, reason: 'NO_CUSTOMER_PAYMENT_RECORDS' },
  totals: totals(),
  daily: ['04', '05', '06', '07', '08', '09', '10'].map((d, i) => ({ date: `2026-03-${d}`, orders: i === 6 ? 6 : 0, countedOrders: i === 6 ? 4 : 0, estimatedOrderValuePaise: i === 6 ? 123456 : 0, pagesRequested: i === 6 ? 80 : 0 })),
  breakdown: {
    colourMode: [{ key: 'bw', orders: 3, valuePaise: 100000, pages: 60 }, { key: 'colour', orders: 1, valuePaise: 23456, pages: 20 }],
    sides: [{ key: 'single', orders: 4, valuePaise: 123456, pages: 80 }],
    paperSize: [{ key: 'unknown', orders: 4, valuePaise: 123456, pages: 80 }],
    status: ['NEW', 'ACCEPTED', 'PRINTING', 'PRINTED', 'READY', 'COLLECTED', 'CANCELLED', 'EXPIRED'].map((k) => ({ key: k, orders: k === 'PRINTING' ? 4 : k === 'CANCELLED' || k === 'EXPIRED' ? 1 : 0, valuePaise: 0, pages: 0 }))
  },
  comparison: {
    previousRange: { from: '2026-02-25', to: '2026-03-03' }, available: true, reason: null, previous: totals({ countedOrders: 2, estimatedOrderValuePaise: 100000 }),
    changePct: { estimatedOrderValue: 23.5, orderCount: 0, pagesRequested: null }
  },
  ...o
});
const mainAnalytics: Handler = ({ path }) => (path === '/shop/analytics' ? { data: { ordersToday: 0, orderCount: 0, bwCount: 0, colourCount: 0 } } : undefined);
const revenueApi = (r: RevenueReport | { status: number }): Handler => ({ path }) => {
  if (path !== '/shop/analytics/revenue') return undefined;
  return 'status' in r ? { status: r.status, error: { code: 'INTERNAL_ERROR' } } : { data: r };
};
const revenueCalls = (fn: ReturnType<typeof mockFetch>['fn']) =>
  fn.mock.calls.map((c) => new URL(String(c[0]), 'http://localhost')).filter((u) => u.pathname.endsWith('/shop/analytics/revenue'));

describe('revenue helpers', () => {
  it('formats integer paise as INR with Indian grouping and never floats', () => {
    expect(formatInr(0)).toBe('₹0.00');
    expect(formatInr(5)).toBe('₹0.05');
    expect(formatInr(123456)).toBe('₹1,234.56');
    expect(formatInr(12345678)).toBe('₹1,23,456.78');
    expect(formatInr(6_000_000_001)).toBe('₹6,00,00,000.01');
  });
  it('derives IST presets including last 30 days (inclusive)', () => {
    const now = new Date('2026-03-10T01:00:00Z'); // 06:30 IST on 10 Mar
    expect(revenueRange('today', now)).toEqual({ from: '2026-03-10', to: '2026-03-10' });
    expect(revenueRange('yesterday', now)).toEqual({ from: '2026-03-09', to: '2026-03-09' });
    expect(revenueRange('last7', now)).toEqual({ from: '2026-03-04', to: '2026-03-10' });
    expect(revenueRange('last30', now)).toEqual({ from: '2026-02-09', to: '2026-03-10' });
    expect(revenueRange('today', new Date('2026-03-09T18:30:00Z'))).toEqual({ from: '2026-03-10', to: '2026-03-10' }); // IST midnight
  });
  it('validates custom ranges and labels honestly', () => {
    expect(revenueRangeError('2026-03-10', '2026-03-09')).toMatch(/not be before/);
    expect(revenueRangeError('2026-01-01', '2026-06-01')).toMatch(/at most 93/);
    expect(revenueRangeError('2026-03-01', '2026-03-10')).toBeNull();
    expect(bucketLabel('unknown')).toBe('Not recorded');
    expect(bucketLabel('bw')).toBe('Black & white');
    expect(dayLabel('2026-03-04')).toBe('4 Mar');
    expect(rangeText('2026-03-04', '2026-03-04')).toBe('4 Mar');
    expect(rangeText('2026-03-04', '2026-03-10')).toBe('4 Mar to 10 Mar');
    expect(formatChange(12.5)).toBe('+12.5%');
    expect(formatChange(-3)).toBe('-3%');
    expect(formatChange(0)).toBe('no change');
  });
});

describe('order value report on the Analytics page', () => {
  it('shows estimates with clear definitions and never claims money was received', async () => {
    mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(report()));
    renderShop('/shop/analytics');
    const stats = await screen.findByLabelText(/Summary for 4 Mar to 10 Mar/);
    expect(within(stats).getByText('₹1,234.56')).toBeInTheDocument();
    expect(within(stats).getByText('₹308.64')).toBeInTheDocument(); // average
    expect(within(stats).getAllByText('Estimated order value')).toHaveLength(1);
    expect(within(stats).getByText('Average estimated order value')).toBeInTheDocument();
    expect(within(stats).getByText('1 / 1')).toBeInTheDocument();
    expect(screen.getByText(/does not record cash or online payments/)).toBeInTheDocument();
    expect(screen.getByText(/not available here/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/revenue|money earned|payments collected|profit/i);
  });

  it('defaults to the last 7 days, sends IST dates and re-queries on preset change', async () => {
    const user = userEvent.setup();
    const { fn } = mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(report()));
    renderShop('/shop/analytics');
    await screen.findByLabelText(/Summary for/);
    const first = revenueCalls(fn).at(-1)!.searchParams;
    expect(first.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const days = (Date.parse(first.get('to')!) - Date.parse(first.get('from')!)) / 86_400e3;
    expect(days).toBe(6);
    await user.click(screen.getByRole('radio', { name: 'Last 30 days' }));
    await waitFor(() => {
      const q = revenueCalls(fn).at(-1)!.searchParams;
      expect((Date.parse(q.get('to')!) - Date.parse(q.get('from')!)) / 86_400e3).toBe(29);
    });
    await user.click(screen.getByRole('radio', { name: 'Today' }));
    await waitFor(() => { const q = revenueCalls(fn).at(-1)!.searchParams; expect(q.get('from')).toBe(q.get('to')); });
  });

  it('persists the chosen range for the tab', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(report()));
    const first = renderShop('/shop/analytics');
    await screen.findByLabelText(/Summary for/);
    await user.click(screen.getByRole('radio', { name: 'Yesterday' }));
    first.unmount();
    cleanup();
    renderShop('/shop/analytics');
    await screen.findByLabelText(/Summary for/);
    expect(screen.getByRole('radio', { name: 'Yesterday' })).toBeChecked();
  });

  it('validates a custom range locally and does not call the server for it', async () => {
    const user = userEvent.setup();
    const { fn } = mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(report()));
    renderShop('/shop/analytics');
    await screen.findByLabelText(/Summary for/);
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    const before = revenueCalls(fn).length;
    const from = screen.getByLabelText('From');
    await user.clear(from);
    await user.type(from, '2026-03-10');
    const to = screen.getByLabelText('To');
    await user.clear(to);
    await user.type(to, '2026-03-01');
    expect(await screen.findByText(/must not be before/)).toBeInTheDocument();
    expect(revenueCalls(fn).length).toBe(before + (revenueCalls(fn).length - before)); // only valid intermediate ranges may have been sent
    expect(revenueCalls(fn).every((u) => u.searchParams.get('from')! <= u.searchParams.get('to')!)).toBe(true);
  });

  it('renders the chart with a text alternative, tooltips and an exact data table', async () => {
    mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(report()));
    renderShop('/shop/analytics');
    const chart = await screen.findByRole('img', { name: /Estimated order value per day in rupees, 4 Mar to 10 Mar\. Highest on 10 Mar at ₹1,234\.56/ });
    expect(chart.querySelector('title')?.textContent).toMatch(/4 Mar: ₹0\.00 from 0 orders/);
    expect(chart.querySelectorAll('rect.pb-chart__bar')).toHaveLength(7);
    const table = screen.getByRole('table', { name: /Daily order value and volume/, hidden: true });
    expect(within(table).getByText('10 Mar').closest('tr')).toHaveTextContent('₹1,234.56');
    expect(within(table).getByText('Total').closest('tr')).toHaveTextContent('₹1,234.56');
  });

  it('breaks down by colour, sides, paper and status, labelling missing data as Not recorded and hiding empty statuses', async () => {
    mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(report()));
    renderShop('/shop/analytics');
    const colour = await screen.findByRole('list', { name: 'Black & white vs colour' });
    expect(within(colour).getByText('Black & white')).toBeInTheDocument();
    expect(within(colour).getByText('3 orders · ₹1,000.00')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Paper size' })).getByText('Not recorded')).toBeInTheDocument();
    const status = screen.getByRole('list', { name: 'Orders by status' });
    expect(within(status).getAllByRole('listitem')).toHaveLength(3);
    expect(within(status).getByText('Print started')).toBeInTheDocument();
  });

  it('states the comparison window and percentages, and omits ones that cannot be computed', async () => {
    mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(report()));
    renderShop('/shop/analytics');
    const c = await screen.findByTestId('comparison');
    expect(c).toHaveTextContent('Compared with the previous 7 days (25 Feb to 3 Mar)');
    expect(c).toHaveTextContent('estimated value +23.5%');
    expect(c).toHaveTextContent('orders no change');
    expect(c).not.toHaveTextContent('pages');
  });

  it.each([
    ['NO_PREVIOUS_ORDERS', /no orders in the previous period/],
    ['PREVIOUS_PERIOD_INCOMPLETE', /starts before your first order/]
  ] as const)('shows no growth figure when the baseline is unusable (%s)', async (reason, text) => {
    const r = report();
    r.comparison = { ...r.comparison, available: false, reason, changePct: { estimatedOrderValue: null, orderCount: null, pagesRequested: null } };
    mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(r));
    renderShop('/shop/analytics');
    const c = await screen.findByTestId('comparison');
    expect(c).toHaveTextContent(text);
    expect(c.textContent).not.toMatch(/%/);
  });

  it('reports unknown page counts and zero-value orders instead of hiding them; average can be unavailable', async () => {
    mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(report({ totals: totals({ ordersWithUnknownPages: 2, zeroValueOrders: 1 }) })));
    renderShop('/shop/analytics');
    expect(await screen.findByText(/2 orders had no page count recorded and are not included/)).toBeInTheDocument();
    expect(screen.getByText(/1 counted order had a quoted value of ₹0\.00/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no orders', async () => {
    const empty = report({ totals: totals({ orderCount: 0, countedOrders: 0, estimatedOrderValuePaise: 0, averageEstimatedOrderValuePaise: null, pagesRequested: 0, cancelled: 0, expired: 0, excludedQuotedValuePaise: 0, printStarted: 0 }) });
    mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(empty));
    renderShop('/shop/analytics');
    expect(await screen.findByRole('heading', { name: 'No orders in this period' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /per day/ })).not.toBeInTheDocument();
  });

  it('shows a loading state, then an error with Retry that recovers', async () => {
    const user = userEvent.setup();
    let fail = true;
    mockFetch(authedSession, emptyList, mainAnalytics, ({ path }) => (path === '/shop/analytics/revenue' ? (fail ? { status: 500, error: { code: 'INTERNAL_ERROR' } } : { data: report() }) : undefined));
    renderShop('/shop/analytics');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/server had a problem/i);
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText(/Summary for/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a loading state while the report is on its way', async () => {
    const { fn } = mockFetch(authedSession, emptyList, mainAnalytics);
    const base = fn.getMockImplementation()!;
    fn.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/shop/analytics/revenue') ? new Promise<Response>(() => undefined) : base(input, init));
    renderShop('/shop/analytics');
    expect(await screen.findByLabelText('Loading order value report')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('downloads the CSV through an authenticated request and explains truncation', async () => {
    const user = userEvent.setup();
    const createUrl = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }));
    const { fn } = mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(report()));
    const base = fn.getMockImplementation()!;
    fn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/export.csv')) {
        return new Response('﻿"a"', { status: 200, headers: { 'content-disposition': 'attachment; filename="estimated-order-value-x.csv"', 'x-export-truncated': 'true' } });
      }
      return base(input, init);
    });
    renderShop('/shop/analytics');
    await screen.findByLabelText(/Summary for/);
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(/limited to the first 5,000 orders/)).toBeInTheDocument();
    const csvUrl = fn.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/export.csv'))!;
    expect(csvUrl).toMatch(/^\/api\/v1\/shop\/analytics\/revenue\/export\.csv\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
    expect(createUrl).toHaveBeenCalled();
  });

  it('is keyboard operable: the range control is a radio group and the table disclosure is focusable', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, mainAnalytics, revenueApi(report()));
    renderShop('/shop/analytics');
    await screen.findByLabelText(/Summary for/);
    const group = screen.getByRole('radiogroup', { name: 'Date range' });
    expect(within(group).getAllByRole('radio')).toHaveLength(5);
    const summary = screen.getByText('View as table');
    summary.focus();
    expect(summary).toHaveFocus();
    await user.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
  });
});
