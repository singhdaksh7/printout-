import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt, shopOk } from './testutils';
import type { PublicAvailability } from '../../lib/customer-api';
import { emptyWeek } from '../../lib/hours';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const weekly = { ...emptyWeek(), mon: [{ start: '09:00', end: '18:00' }], tue: [{ start: '21:00', end: '02:00' }] };
const avail = (o: Partial<PublicAvailability> = {}): PublicAvailability => ({
  state: 'open', reason: 'schedule', closureReason: null, closesAt: '2026-10-19T12:30:00.000Z', nextOpenAt: null,
  serverTime: '2026-10-19T05:00:00.000Z', timezone: 'Asia/Kolkata', orderingBlocked: false,
  today: { date: '2026-10-19', day: 'mon', closedAllDay: false, reason: null, intervals: [{ start: '09:00', end: '18:00' }] },
  weeklyHours: weekly, upcomingClosures: [], temporaryClosure: null, ...o
});
const shop = (a?: PublicAvailability, extra: object = {}) => ({ ...shopOk, ...(a ? { availability: a } : {}), ...extra });

describe('customer availability', () => {
  it('shows Open now, closing time (in the shop timezone) and today\'s hours', async () => {
    mockApi({ 'GET /public/shops/demo-shop': { data: shop(avail()) } });
    renderAt('/p/demo-shop');
    const panel = (await screen.findByRole('heading', { name: 'Opening hours' })).closest('section')!;
    expect(within(panel).getByText('Open now')).toBeInTheDocument();
    expect(within(panel).getByText(/Closes 6:00 PM/)).toBeInTheDocument();
    expect(within(panel).getByText('Today: 9:00 AM – 6:00 PM')).toBeInTheDocument();
    expect(screen.getByText('Choose a file', { exact: false })).toBeInTheDocument();
  });

  it('weekly hours are an accessible expandable section, with overnight and closed days', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /public/shops/demo-shop': { data: shop(avail()) } });
    renderAt('/p/demo-shop');
    const summary = await screen.findByText('Weekly hours');
    expect(summary.tagName).toBe('SUMMARY');
    await user.click(summary);
    const table = screen.getByRole('table', { name: /Weekly opening hours/ });
    expect(within(table).getByRole('row', { name: /Tuesday.*9:00 PM – 2:00 AM \(next day\)/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /Wednesday.*Closed/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /Monday/ })).toHaveAttribute('aria-current', 'date');
  });

  it('closed with ACCEPT policy: shows next opening, still allows ordering', async () => {
    mockApi({ 'GET /public/shops/demo-shop': { data: shop(avail({ state: 'closed', reason: 'outside_hours', closesAt: null, nextOpenAt: '2026-10-20T03:30:00.000Z', serverTime: '2026-10-19T14:00:00.000Z' })) } });
    renderAt('/p/demo-shop');
    expect(await screen.findByText('Closed now')).toBeInTheDocument();
    expect(screen.getByText(/Opens Tue 9:00 AM/)).toBeInTheDocument();
    expect(screen.getByText(/You can still send your order now/)).toBeInTheDocument();
    expect(screen.getByText(/Choose a file/)).toBeInTheDocument();
  });

  it('closed with BLOCK policy: no upload UI, clear message, tracking link kept', async () => {
    mockApi({ 'GET /public/shops/demo-shop': { data: shop(avail({ state: 'closed', reason: 'temporary_closure', closesAt: null, nextOpenAt: null, orderingBlocked: true, temporaryClosure: { reason: 'Power cut', until: null } })) } });
    renderAt('/p/demo-shop');
    expect(await screen.findByText('Temporarily closed')).toBeInTheDocument();
    expect(screen.getByText('Power cut')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Closed for new orders' })).toBeInTheDocument();
    expect(screen.queryByText(/Choose a file/)).toBeNull();
  });

  it('never claims open when availability cannot be determined', async () => {
    mockApi({ 'GET /public/shops/demo-shop': { data: shop(avail({ state: 'unknown', reason: 'not_configured', closesAt: null, today: null, weeklyHours: null })) } });
    renderAt('/p/demo-shop');
    await screen.findByText(/Choose a file/);
    expect(screen.queryByText('Open now')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Opening hours' })).toBeNull();
  });

  it('old API without availability still works (no panel, ordering unchanged)', async () => {
    mockApi({ 'GET /public/shops/demo-shop': { data: shop() } });
    renderAt('/p/demo-shop');
    await screen.findByText(/Choose a file/);
    expect(screen.queryByText('Open now')).toBeNull();
  });

  it('uses the server clock: a wrong device clock does not change what is shown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    mockApi({ 'GET /public/shops/demo-shop': { data: shop(avail()) } });
    renderAt('/p/demo-shop');
    expect(await screen.findByText('Open now')).toBeInTheDocument();
    expect(screen.getByText(/Closes 6:00 PM/)).toBeInTheDocument();
  });

  it('special closure today shows the reason and next opening', async () => {
    mockApi({ 'GET /public/shops/demo-shop': { data: shop(avail({ state: 'closed', reason: 'special_closure', closureReason: 'Diwali', closesAt: null, nextOpenAt: '2026-10-21T03:30:00.000Z', today: { date: '2026-10-20', day: 'tue', closedAllDay: true, reason: 'Diwali', intervals: [] }, serverTime: '2026-10-20T05:00:00.000Z' })) } });
    renderAt('/p/demo-shop');
    expect(await screen.findByText('Closed today')).toBeInTheDocument();
    expect(screen.getAllByText(/Diwali/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Opens Wed 9:00 AM/)).toBeInTheDocument();
  });
});
