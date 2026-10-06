import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt } from './testutils';

const TOKEN = 'k'.repeat(40);
const order = (over: Record<string, unknown> = {}) => ({ orderNumber: 'DEMO-9', shopName: 'Demo Copy Centre', status: 'NEW', totalPaise: 2400, currency: 'INR', retentionMinutes: 30, updatedAt: '2030-01-01T10:00:00.000Z', ...over });

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('tracking', () => {
  it.each([
    ['NEW', 'Submitted'], ['ACCEPTED', 'Accepted'], ['PRINTING', 'Print started'], ['PRINTED', 'Print confirmed'], ['READY', 'Ready'], ['COLLECTED', 'Collected']
  ])('highlights %s as the current step', async (status, label) => {
    mockApi({ [`GET /public/orders/${TOKEN}`]: { data: order({ status }) } });
    renderAt(`/t/${TOKEN}`);
    const current = await screen.findByText(label, { selector: '.cx-step-label' });
    expect(current.closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getAllByRole('listitem').filter((li) => li.getAttribute('aria-current') === 'step')).toHaveLength(1);
    expect(screen.getByText('Estimated amount')).toBeInTheDocument();
    expect(screen.getByText('₹24.00')).toBeInTheDocument();
    expect(screen.getByText(/pay the shop directly/)).toBeInTheDocument();
  });

  it('shows timestamps and a configuration summary when the API provides them', async () => {
    mockApi({ [`GET /public/orders/${TOKEN}`]: { data: order({ status: 'ACCEPTED', statusHistory: [{ toStatus: 'NEW', createdAt: '2030-01-01T09:00:00Z' }, { toStatus: 'ACCEPTED', createdAt: '2030-01-01T09:05:00Z' }], printOptions: { colourMode: 'colour', sides: 'duplex', copies: 2, pageSelection: { mode: 'ranges', ranges: [{ from: 1, to: 3 }] } } }) } });
    renderAt(`/t/${TOKEN}`);
    expect(await screen.findByText(/Colour · Double-sided · 2 copies · Pages 1-3/)).toBeInTheDocument();
    expect(document.querySelectorAll('.cx-timeline .cx-tnum').length).toBe(2);
  });

  it('understands the API payload shape (nested document, timeline)', async () => {
    mockApi({ [`GET /public/orders/${TOKEN}`]: { data: order({ status: 'READY', timeline: [{ status: 'NEW', at: '2030-01-01T09:00:00Z' }], document: { status: 'DELETED', deleteAfter: '2030-01-01T09:30:00Z', deletedAt: '2030-01-01T09:31:00Z' } }) } });
    renderAt(`/t/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Your file has been deleted' })).toBeInTheDocument();
    expect(document.querySelectorAll('.cx-timeline .cx-tnum').length).toBeGreaterThan(0);
  });

  it('shows cancelled and expired terminal states without a timeline', async () => {
    mockApi({ [`GET /public/orders/${TOKEN}`]: { data: order({ status: 'CANCELLED' }) } });
    const a = renderAt(`/t/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Order cancelled' })).toBeInTheDocument();
    expect(document.querySelector('.cx-timeline')).toBeNull();
    a.unmount();
    mockApi({ [`GET /public/orders/${TOKEN}`]: { data: order({ status: 'EXPIRED' }) } });
    renderAt(`/t/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Order expired' })).toBeInTheDocument();
  });

  it('shows a generic not-found for an unknown token', async () => {
    mockApi({ [`GET /public/orders/${TOKEN}`]: { status: 404, error: { code: 'NOT_FOUND' } } });
    renderAt(`/t/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Order not found' })).toBeInTheDocument();
  });

  it('shows already-deleted documents while the order stays trackable', async () => {
    mockApi({ [`GET /public/orders/${TOKEN}`]: { data: order({ status: 'READY', documentStatus: 'DELETED', documentDeleteAfter: '2030-01-01T09:30:00Z' }) } });
    renderAt(`/t/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Your file has been deleted' })).toBeInTheDocument();
    expect(screen.getByText('Ready', { selector: '.cx-step-label' })).toBeInTheDocument();
  });

  it('links back to the shop when the slug is known and copies the link', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockApi({ [`GET /public/orders/${TOKEN}`]: { data: order({ shopSlug: 'demo-shop' }) } });
    renderAt(`/t/${TOKEN}`);
    expect(await screen.findByRole('link', { name: 'Back to shop' })).toHaveAttribute('href', '/p/demo-shop');
    await user.click(screen.getByRole('button', { name: 'Copy tracking link' }));
    expect(writeText).toHaveBeenCalled();
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });
});

describe('countdown and polling (fake timers)', () => {
  const NOW = new Date('2030-01-01T09:00:00.000Z');
  const setup = async (data: () => Record<string, unknown> | 'network') => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const m = mockApi({ [`GET /public/orders/${TOKEN}`]: () => { const d = data(); return d === 'network' ? 'network' as const : { data: d }; } });
    renderAt(`/t/${TOKEN}`);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    return m;
  };
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const get = (m: ReturnType<typeof mockApi>) => m.count('GET', `/public/orders/${TOKEN}`);

  it('counts down from the server deleteAfter and reaches the deleted state, refetching once', async () => {
    const m = await setup(() => order({ status: 'PRINTED', documentDeleteAfter: '2030-01-01T09:00:03.000Z' }));
    expect(screen.getByTestId('countdown')).toHaveTextContent('0:03');
    await tick(1000);
    expect(screen.getByTestId('countdown')).toHaveTextContent('0:02');
    const before = get(m);
    await tick(2500);
    expect(screen.getByRole('heading', { name: 'Your file has been deleted' })).toBeInTheDocument();
    expect(screen.queryByTestId('countdown')).toBeNull();
    expect(get(m)).toBeGreaterThan(before);
  });

  it.each([[1, '1 minute'], [45, '45 minutes']])('retention wording follows the server retentionMinutes=%s', async (n, phrase) => {
    await setup(() => order({ status: 'PRINTED', retentionMinutes: n, documentDeleteAfter: '2030-01-01T09:00:30.000Z' }));
    expect(screen.getByText(`Your temporary file is deleted ${phrase} after the shop starts printing.`)).toBeInTheDocument();
  });

  it('falls back to 30 minutes wording (display only) when the server omits retentionMinutes', async () => {
    await setup(() => { const { retentionMinutes: _omit, ...o } = order({ status: 'PRINTED', documentDeleteAfter: '2030-01-01T09:00:30.000Z' }); return o; });
    expect(screen.getByText('Your temporary file is deleted 30 minutes after the shop starts printing.')).toBeInTheDocument();
    expect(screen.getByTestId('countdown')).toHaveTextContent('0:30');
  });

  it('corrects for server clock skew using serverTime', async () => {
    // Device clock is 10 minutes behind the server: server says it is 09:10, deletion at 09:10:30.
    await setup(() => order({ status: 'PRINTED', serverTime: '2030-01-01T09:10:00.000Z', documentDeleteAfter: '2030-01-01T09:10:30.000Z' }));
    expect(screen.getByTestId('countdown')).toHaveTextContent('0:30');
  });

  it('polls every ~5s while active and stops at a terminal status', async () => {
    let status = 'NEW';
    const m = await setup(() => order({ status }));
    expect(get(m)).toBe(1);
    await tick(5100);
    expect(get(m)).toBe(2);
    status = 'COLLECTED';
    await tick(5100);
    expect(screen.getByText('Collected', { selector: '.cx-step-label' }).closest('li')).toHaveAttribute('aria-current', 'step');
    const n = get(m);
    await tick(30000);
    expect(get(m)).toBe(n);
  });

  it('backs off on errors and keeps the last known status', async () => {
    let fail = false;
    const m = await setup(() => (fail ? 'network' : order({ status: 'ACCEPTED' })));
    fail = true;
    await tick(5100);
    expect(screen.getByText(/Having trouble updating/)).toBeInTheDocument();
    const n = get(m);
    await tick(5100); // back-off is now 10s: no new request yet
    expect(get(m)).toBe(n);
    await tick(6000);
    expect(get(m)).toBe(n + 1);
    expect(screen.getByText('Accepted', { selector: '.cx-step-label' })).toBeInTheDocument();
  });

  it('pauses polling while the tab is hidden and resumes when visible', async () => {
    const m = await setup(() => order({ status: 'ACCEPTED' }));
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await tick(5100); // the already-scheduled tick fires, sees hidden, stops
    const n = get(m);
    await tick(20000);
    expect(get(m)).toBe(n);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(10); });
    expect(get(m)).toBe(n + 1);
  });
});
