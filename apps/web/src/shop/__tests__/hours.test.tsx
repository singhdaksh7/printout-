import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, emptyList, mockFetch, renderShop, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';
import { emptyWeek, validateWeek, formatClock, describeDay, type WeeklyHours } from '../../lib/hours';
import type { ShopHours } from '../../lib/shop-api';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const week = (o: Partial<WeeklyHours>): WeeklyHours => ({ ...emptyWeek(), ...o });

describe('hours helpers', () => {
  it('formats clock times', () => {
    expect(formatClock('00:00')).toBe('12:00 AM');
    expect(formatClock('09:05')).toBe('9:05 AM');
    expect(formatClock('12:00')).toBe('12:00 PM');
    expect(formatClock('24:00')).toBe('12:00 AM');
  });
  it('describes days incl. overnight, 24h and closed', () => {
    expect(describeDay([])).toBe('Closed');
    expect(describeDay([{ start: '00:00', end: '24:00' }])).toBe('Open 24 hours');
    expect(describeDay([{ start: '21:00', end: '02:00' }])).toBe('9:00 PM – 2:00 AM (next day)');
  });
  it('mirrors server validation (overlap, equal times, week wrap)', () => {
    expect(validateWeek(week({ mon: [{ start: '09:00', end: '18:00' }] }))).toEqual({});
    expect(validateWeek(week({ mon: [{ start: '09:00', end: '09:00' }] })).mon).toMatch(/differ/);
    expect(validateWeek(week({ mon: [{ start: '09:00', end: '13:00' }, { start: '12:00', end: '17:00' }] })).mon).toMatch(/overlap/);
    expect(validateWeek(week({ sun: [{ start: '22:00', end: '03:00' }], mon: [{ start: '02:00', end: '05:00' }] })).mon).toMatch(/overlap/);
    expect(validateWeek(week({ mon: [{ start: '', end: '10:00' }] })).mon).toMatch(/both/);
  });
});

const baseHours = (o: Partial<ShopHours> = {}): ShopHours => ({
  timezone: 'Asia/Kolkata', weeklyHours: week({ mon: [{ start: '09:00', end: '18:00' }] }), specialClosures: [], afterHoursPolicy: 'ACCEPT',
  temporaryClosure: null, reopenUntil: null,
  availability: { state: 'open', reason: 'schedule', closureReason: null, closesAt: '2026-10-19T12:30:00.000Z', nextOpenAt: null, serverTime: '2026-10-19T05:00:00.000Z' },
  ...o
});

function hoursApi(store: { h: ShopHours }): Handler[] {
  return [
    ({ method, path }) => (method === 'GET' && path === '/shop/hours' ? { data: store.h } : undefined),
    ({ method, path, body }) => {
      if (method === 'PUT' && path === '/shop/hours') {
        store.h = { ...store.h, ...(body.timezone ? { timezone: body.timezone } : {}), ...('weeklyHours' in body ? { weeklyHours: body.weeklyHours } : {}), ...(body.specialClosures ? { specialClosures: body.specialClosures } : {}), ...(body.afterHoursPolicy ? { afterHoursPolicy: body.afterHoursPolicy } : {}) };
        return { data: store.h };
      }
      if (method === 'PUT' && path === '/shop/hours/temporary-closure') {
        store.h = { ...store.h, temporaryClosure: { reason: body.reason, startedAt: 'x', until: body.until }, availability: { ...store.h.availability, state: 'closed', reason: 'temporary_closure', closureReason: body.reason, closesAt: null } };
        return { data: store.h };
      }
      if (method === 'DELETE' && path === '/shop/hours/temporary-closure') {
        store.h = { ...store.h, temporaryClosure: null, availability: { ...store.h.availability, state: 'open', reason: 'schedule' } };
        return { data: store.h };
      }
      if (method === 'POST' && path === '/shop/hours/reopen') {
        store.h = { ...store.h, reopenUntil: '2026-10-19T08:00:00.000Z', availability: { ...store.h.availability, state: 'open', reason: 'emergency_reopen' } };
        return { data: store.h };
      }
      return undefined;
    },
    ({ path }) => (path === '/shop/settings' ? { data: { displayName: 'Central Print', acceptsOrders: true } } : undefined),
    ({ path }) => (path === '/shop/qr' ? { data: { publicUrl: 'https://printout.test/p/central', slug: 'central' } } : undefined)
  ];
}

describe('Operating hours section', () => {
  it('loads the schedule and current status, and saves only what changed through the explicit Save', async () => {
    const user = userEvent.setup();
    const store = { h: baseHours() };
    const { calls } = mockFetch(authedSession, emptyList, ...hoursApi(store));
    renderShop('/shop/settings');
    const status = await screen.findByRole('status', { name: 'Current shop status' });
    expect(status).toHaveTextContent('Open now');
    expect(screen.getByLabelText('Monday opens')).toHaveValue('09:00');
    expect(screen.getByLabelText('Monday open')).toBeChecked();
    expect(screen.getByLabelText('Tuesday open')).not.toBeChecked();
    const save = screen.getByRole('button', { name: 'Save operating hours' });
    expect(save).toBeDisabled();
    await user.click(screen.getByLabelText('Tuesday open'));
    expect(screen.getByText('Unsaved hours changes')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Do not accept new orders/ }));
    await user.click(save);
    expect(await screen.findByText('Operating hours saved')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/shop/hours')!;
    expect(put.body.afterHoursPolicy).toBe('BLOCK');
    expect(put.body.weeklyHours.tue).toEqual([{ start: '09:00', end: '18:00' }]);
    expect(put.body.timezone).toBe('Asia/Kolkata');
  });

  it('blocks saving overlapping intervals with an accessible error and sends nothing', async () => {
    const user = userEvent.setup();
    const store = { h: baseHours() };
    const { calls } = mockFetch(authedSession, emptyList, ...hoursApi(store));
    renderShop('/shop/settings');
    await screen.findByLabelText('Monday opens');
    await user.click(screen.getByRole('button', { name: 'Add hours for Monday' }));
    const second = screen.getByLabelText('Monday opens (2)');
    await user.clear(second); await user.type(second, '12:00');
    await user.click(screen.getByRole('button', { name: 'Save operating hours' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/overlap/i);
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/shop/hours')).toBe(false);
  });

  it('Cancel restores the saved values', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, ...hoursApi({ h: baseHours() }));
    renderShop('/shop/settings');
    const opens = await screen.findByLabelText('Monday opens');
    await user.clear(opens); await user.type(opens, '10:30');
    expect(screen.getByLabelText('Monday opens')).toHaveValue('10:30');
    await user.click(screen.getByRole('button', { name: 'Cancel changes' }));
    expect(screen.getByLabelText('Monday opens')).toHaveValue('09:00');
  });

  it('adds and removes holiday closures (kept until saved) and rejects duplicates', async () => {
    const user = userEvent.setup();
    const store = { h: baseHours() };
    const { calls } = mockFetch(authedSession, emptyList, ...hoursApi(store));
    renderShop('/shop/settings');
    await screen.findByLabelText('Closure date');
    await user.type(screen.getByLabelText('Closure date'), '2026-11-08');
    await user.type(screen.getByLabelText('Reason (optional)'), 'Diwali');
    await user.click(screen.getByRole('button', { name: 'Add closed date' }));
    const list = screen.getByRole('list', { name: 'Closed dates' });
    expect(within(list).getByText(/Diwali/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Closure date'), '2026-11-08');
    await user.click(screen.getByRole('button', { name: 'Add closed date' }));
    expect(await screen.findByText('That date is already in the list.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save operating hours' }));
    await screen.findByText('Operating hours saved');
    expect(calls.find((c) => c.method === 'PUT' && c.path === '/shop/hours')!.body.specialClosures).toEqual([{ date: '2026-11-08', reason: 'Diwali' }]);
  });

  it('close now / reopen now act immediately', async () => {
    const user = userEvent.setup();
    const store = { h: baseHours() };
    const { calls } = mockFetch(authedSession, emptyList, ...hoursApi(store));
    renderShop('/shop/settings');
    await user.type(await screen.findByLabelText('Reason for closing (optional)'), 'Power cut');
    await user.click(screen.getByRole('button', { name: 'Close shop now' }));
    expect(await screen.findByText('Temporary closure is on')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/shop/hours/temporary-closure')!;
    expect(put.body).toEqual({ reason: 'Power cut', until: null });
    await user.click(screen.getByRole('button', { name: 'Reopen now' }));
    expect(await screen.findByLabelText('Reason for closing (optional)')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/shop/hours/temporary-closure')).toBe(true);
  });

  it('emergency reopen is offered only when closed', async () => {
    const user = userEvent.setup();
    const closed = baseHours({ availability: { state: 'closed', reason: 'outside_hours', closureReason: null, closesAt: null, nextOpenAt: '2026-10-20T03:30:00.000Z', serverTime: '2026-10-19T14:00:00.000Z' } });
    const { calls } = mockFetch(authedSession, emptyList, ...hoursApi({ h: closed }));
    renderShop('/shop/settings');
    await user.click(await screen.findByRole('button', { name: 'Reopen shop now' }));
    expect(await screen.findByText('Emergency reopening is on')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/shop/hours/reopen')!.body).toEqual({ minutes: 120 });
  });

  it('shows a server validation error without losing the form', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList,
      ({ method, path }) => (method === 'PUT' && path === '/shop/hours' ? { status: 400, error: { code: 'VALIDATION_ERROR' } } : undefined),
      ...hoursApi({ h: baseHours() }));
    renderShop('/shop/settings');
    await user.click(await screen.findByRole('radio', { name: /Do not accept new orders/ }));
    await user.click(screen.getByRole('button', { name: 'Save operating hours' }));
    expect(await screen.findByText(/Some values are not valid/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Do not accept new orders/ })).toBeChecked();
  });

  it('degrades gracefully when hours cannot load; the rest of Settings still works', async () => {
    mockFetch(authedSession, emptyList, ({ path }) => (path === '/shop/hours' ? { status: 500, error: { code: 'INTERNAL_ERROR' } } : undefined), ...hoursApi({ h: baseHours() }).slice(2));
    renderShop('/shop/settings');
    expect(await screen.findByLabelText('Shop name')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('no schedule: unchecking the toggle hides the editor and saves weeklyHours: null only on Save', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, emptyList, ...hoursApi({ h: baseHours() }));
    renderShop('/shop/settings');
    await user.click(await screen.findByRole('switch', { name: 'Use a weekly schedule' }));
    expect(screen.queryByLabelText('Monday opens')).toBeNull();
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/shop/hours')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save operating hours' }));
    await screen.findByText('Operating hours saved');
    expect(calls.find((c) => c.method === 'PUT' && c.path === '/shop/hours')!.body.weeklyHours).toBeNull();
  });
});
