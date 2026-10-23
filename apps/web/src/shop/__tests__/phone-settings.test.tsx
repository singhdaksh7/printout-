import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setPhoneAuthFactory } from '../../lib/phone-auth';
import { setCsrfToken } from '../../lib/api';
import { FakeES, authedSession, emptyList, mockFetch, renderShop, type Handler } from './helpers';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); vi.stubEnv('VITE_PHONE_AUTH_MOCK', '1'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); __setPhoneAuthFactory(null); });

const CONFIG = { enabled: true, allowedCallingCodes: ['+91'], defaultCallingCode: '+91', resendCooldownSeconds: 30 };
const settings: Handler = ({ method, path }) => (method === 'GET' && path === '/shop/settings' ? { data: { displayName: 'Central', publicContact: '' } } : undefined);
const cfg: Handler = ({ path }) => (path === '/auth/phone/config' ? { data: CONFIG } : undefined);

function setup(status: unknown, ...extra: Handler[]) {
  const p = { sendCode: vi.fn(async () => undefined), confirm: vi.fn(async () => 'link-token'), reset: vi.fn() };
  __setPhoneAuthFactory(async () => p);
  const m = mockFetch(authedSession, emptyList, settings, cfg, ...extra, ({ method, path }) => (method === 'GET' && path === '/shop/account/phone' ? { data: status } : undefined));
  return { ...m, p };
}

describe('Settings > Phone sign-in', () => {
  it('hidden when the server does not offer phone sign-in', async () => {
    setup({ linked: false, available: false });
    renderShop('/shop/settings');
    await screen.findByRole('heading', { name: 'Settings' });
    await screen.findByLabelText('Shop name');
    expect(screen.queryByTestId('phone-signin')).toBeNull();
  });

  it('links a number: password first, then OTP, then POSTs the ID token and password', async () => {
    const user = userEvent.setup();
    let linked = false;
    const { calls } = setup({ linked: false, available: true }, ({ method, path, body }) => {
      if (method === 'POST' && path === '/shop/account/phone') { linked = true; return { data: { linked: true, phoneMasked: '+91••••••3210', replaced: false, otherSessionsEnded: 2 } }; }
      if (method === 'GET' && path === '/shop/account/phone' && linked) return { data: { linked: true, available: true, phoneMasked: '+91••••••3210', linkedAt: '2026-10-23T00:00:00Z' } };
      void body; return undefined;
    });
    renderShop('/shop/settings');
    await user.click(await screen.findByRole('button', { name: 'Link mobile number' }));
    const panel = screen.getByTestId('phone-link-panel');
    expect(within(panel).queryByLabelText('Mobile number')).toBeNull(); // no SMS before the password step
    await user.type(within(panel).getByLabelText('Current password'), 'hunter2-hunter2');
    await user.click(within(panel).getByRole('button', { name: 'Continue' }));
    await user.type(await within(panel).findByLabelText('Mobile number'), '9876543210');
    await user.click(within(panel).getByRole('button', { name: 'Send OTP' }));
    await within(panel).findByRole('group', { name: '6-digit verification code' });
    await user.keyboard('123456');
    expect(await screen.findByText(/Number linked: \+91••••••3210\. You were signed out on 2 other devices\./)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/shop/account/phone')?.body).toEqual({ idToken: 'link-token', currentPassword: 'hunter2-hunter2' });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/shop/account/phone')?.headers['x-csrf-token']).toBe('csrf-1');
    expect(await screen.findByTestId('phone-linked-number')).toHaveTextContent('+91••••••3210');
  });

  it('wrong password keeps the verified token so the person can correct it and retry', async () => {
    const user = userEvent.setup();
    let n = 0;
    const { p } = setup({ linked: true, available: true, phoneMasked: '+91••••••1111' }, ({ method, path }) => {
      if (method === 'POST' && path === '/shop/account/phone') return ++n === 1 ? { status: 403, error: { code: 'INVALID_CURRENT_PASSWORD' } } : { data: { linked: true, phoneMasked: '+91••••••3210', replaced: true, otherSessionsEnded: 0 } };
      return undefined;
    });
    renderShop('/shop/settings');
    await user.click(await screen.findByRole('button', { name: 'Replace number' }));
    const panel = screen.getByTestId('phone-link-panel');
    await user.type(within(panel).getByLabelText('Current password'), 'wrong-password');
    await user.click(within(panel).getByRole('button', { name: 'Continue' }));
    await user.type(await within(panel).findByLabelText('Mobile number'), '9876543210');
    await user.click(within(panel).getByRole('button', { name: 'Send OTP' }));
    await within(panel).findByRole('group', { name: '6-digit verification code' });
    await user.keyboard('123456');
    expect(await within(panel).findByTestId('phone-error')).toHaveTextContent(/current password is incorrect/i);
    await user.clear(within(panel).getByLabelText('Current password'));
    await user.type(within(panel).getByLabelText('Current password'), 'right-password');
    await user.keyboard('{Tab}');
    await user.click(within(panel).getAllByRole('textbox')[0]!);
    await user.keyboard('123456');
    expect(await screen.findByText(/Number replaced/)).toBeInTheDocument();
    expect(p.confirm).toHaveBeenCalledTimes(1);
  });

  it('unlinks with the current password and tells the person email sign-in still works', async () => {
    const user = userEvent.setup();
    const { calls } = setup({ linked: true, available: true, phoneMasked: '+91••••••3210' }, ({ method, path }) =>
      (method === 'POST' && path === '/shop/account/phone/unlink' ? { data: { linked: false, otherSessionsEnded: 1 } } : undefined));
    renderShop('/shop/settings');
    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    const panel = screen.getByTestId('phone-unlink-panel');
    expect(within(panel).getByRole('button', { name: 'Unlink number' })).toBeDisabled();
    await user.type(within(panel).getByLabelText('Current password'), 'hunter2-hunter2');
    await user.click(within(panel).getByRole('button', { name: 'Unlink number' }));
    expect(await screen.findByText(/Mobile number unlinked\. You can still sign in with email and password\./)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/shop/account/phone/unlink')?.body).toEqual({ currentPassword: 'hunter2-hunter2' });
  });
});
