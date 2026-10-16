import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminRoutes from '../AdminRoutes';
import { setCsrfToken } from '../../lib/api';
import { mockFetch, type Handler } from '../../shop/__tests__/helpers';

beforeEach(() => setCsrfToken(null));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const adminSession = { user: { id: 'a1', displayName: 'Root Admin', role: 'PLATFORM_ADMIN' }, shop: null, csrfToken: 'csrf-a' };
const account = {
  id: 'a1', email: 'root@printout.test', displayName: 'Root Admin', role: 'PLATFORM_ADMIN', createdAt: '2026-01-01T00:00:00Z',
  session: { startedAt: '2026-10-16T08:00:00Z', expiresAt: '2026-10-30T08:00:00Z', otherActiveSessions: 2 }
};
const authed: Handler = ({ method, path }) => (method === 'GET' && path === '/auth/session' ? { data: adminSession } : undefined);
const accountGet: Handler = ({ method, path }) => (method === 'GET' && path === '/admin/account' ? { data: account } : undefined);
const reply = (path: string, result: ReturnType<Handler>): Handler => ({ method, path: p }) => (method === 'POST' && p === path ? result : undefined);
const apiError = (status: number, code: string, message = 'x') => ({ status, error: { code, message } });

function renderAccount(path = '/admin/account') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/*" element={<AdminRoutes />} />
        <Route path="/shop/*" element={<div>SHOP AREA</div>} />
      </Routes>
    </MemoryRouter>
  );
}

async function ready() {
  const user = userEvent.setup();
  renderAccount();
  await screen.findByRole('heading', { name: 'Account settings' });
  await screen.findByText('root@printout.test');
  return user;
}
const emailForm = () => screen.getByRole('region', { name: 'Change email' });
const passwordForm = () => screen.getByRole('region', { name: 'Change password' });

describe('Admin account settings page', () => {
  it('shows the account and session details without any secret', async () => {
    mockFetch(authed, accountGet);
    await ready();
    expect(screen.getByText('Root Admin', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Platform admin', { selector: 'dd' })).toBeInTheDocument();
    const session = screen.getByRole('region', { name: 'Current session' });
    expect(within(session).getByText('2')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/passwordHash|argon2|csrf-a|tokenHash/i);
  });

  it('is reachable from the sidebar and the top bar', async () => {
    mockFetch(authed, accountGet);
    await ready();
    expect(screen.getAllByRole('link', { name: /^Account$/ })[0]).toHaveAttribute('href', '/admin/account');
    expect(screen.getByRole('link', { name: 'Account settings for Root Admin' })).toHaveAttribute('href', '/admin/account');
  });

  it('shows an error with a retry when the account cannot be loaded', async () => {
    let attempts = 0;
    mockFetch(authed, ({ method, path }) => (method === 'GET' && path === '/admin/account' ? (++attempts === 1 ? apiError(500, 'INTERNAL_ERROR') : { data: account }) : undefined));
    const user = userEvent.setup();
    renderAccount();
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('root@printout.test')).toBeInTheDocument();
  });

  it('redirects a shop owner away', async () => {
    mockFetch(({ method, path }) => (method === 'GET' && path === '/auth/session' ? { data: { user: { id: 'u', displayName: 'O', role: 'SHOP_OWNER' }, shop: { id: 's', slug: 'c', displayName: 'C' }, csrfToken: 'x' } } : undefined));
    renderAccount();
    expect(await screen.findByText('SHOP AREA')).toBeInTheDocument();
  });

  describe('change email', () => {
    it('validates locally, focuses the first invalid field and does not call the API', async () => {
      const { calls } = mockFetch(authed, accountGet);
      const user = await ready();
      const form = within(emailForm());
      await user.click(form.getByRole('button', { name: 'Change email' }));
      expect(form.getByLabelText('New email')).toHaveFocus();
      expect(form.getByLabelText('New email')).toHaveAttribute('aria-invalid', 'true');
      expect(form.getByText('Enter the new email address.')).toBeInTheDocument();

      await user.type(form.getByLabelText('New email'), 'not-an-email');
      await user.click(form.getByRole('button', { name: 'Change email' }));
      expect(form.getByText('Enter a valid email address.')).toBeInTheDocument();

      await user.clear(form.getByLabelText('New email'));
      await user.type(form.getByLabelText('New email'), 'ROOT@printout.test');
      await user.click(form.getByRole('button', { name: 'Change email' }));
      expect(form.getByText('This is already your email address.')).toBeInTheDocument();

      await user.clear(form.getByLabelText('New email'));
      await user.type(form.getByLabelText('New email'), 'new@printout.test');
      await user.type(form.getByLabelText('Confirm new email'), 'new@printout.test');
      await user.click(form.getByRole('button', { name: 'Change email' }));
      expect(form.getByLabelText('Current password')).toHaveFocus();
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('requires the new email to be typed twice and focuses the confirmation field on a mismatch', async () => {
      const { calls } = mockFetch(authed, accountGet);
      const user = await ready();
      const form = within(emailForm());
      await user.type(form.getByLabelText('New email'), 'new@printout.test');
      await user.type(form.getByLabelText('Confirm new email'), 'nwe@printout.test');
      await user.type(form.getByLabelText('Current password'), 'my-current-pass');
      await user.click(form.getByRole('button', { name: 'Change email' }));
      expect(form.getByText('The email addresses do not match.')).toBeInTheDocument();
      expect(form.getByLabelText('Confirm new email')).toHaveFocus();
      expect(form.getByLabelText('Confirm new email')).toHaveAttribute('aria-invalid', 'true');
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('submits with Enter, sends CSRF, then lands on the sign-in page with a notice and a closed session', async () => {
      const { calls } = mockFetch(authed, accountGet, reply('/admin/account/email', { data: { email: 'new@printout.test', signedOut: true } }));
      const user = await ready();
      const form = within(emailForm());
      await user.type(form.getByLabelText('New email'), '  New@Printout.test ');
      await user.type(form.getByLabelText('Confirm new email'), 'new@printout.test');
      await user.type(form.getByLabelText('Current password'), 'my-current-pass{Enter}');
      expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/email was changed and you were signed out on all devices/i);
      const post = calls.find((c) => c.path === '/admin/account/email')!;
      expect(post.body).toEqual({ currentPassword: 'my-current-pass', newEmail: 'New@Printout.test' });
      expect(post.headers['x-csrf-token']).toBe('csrf-a');
      expect(document.body.textContent).not.toContain('my-current-pass');
    });

    it('shows a wrong-current-password error on the field, focuses it and clears it', async () => {
      mockFetch(authed, accountGet, reply('/admin/account/email', apiError(403, 'INVALID_CURRENT_PASSWORD')));
      const user = await ready();
      const form = within(emailForm());
      await user.type(form.getByLabelText('New email'), 'new@printout.test');
      await user.type(form.getByLabelText('Confirm new email'), 'new@printout.test');
      await user.type(form.getByLabelText('Current password'), 'wrong-one');
      await user.click(form.getByRole('button', { name: 'Change email' }));
      expect(await form.findByText('Current password is incorrect.')).toBeInTheDocument();
      expect(form.getByLabelText('Current password')).toHaveFocus();
      expect(form.getByLabelText('Current password')).toHaveValue('');
      expect(form.getByLabelText('New email')).toHaveValue('new@printout.test');
      // Still signed in: no redirect.
      expect(screen.getByRole('heading', { name: 'Account settings' })).toBeInTheDocument();
    });

    it('shows the generic duplicate-email message on the email field', async () => {
      mockFetch(authed, accountGet, reply('/admin/account/email', apiError(409, 'EMAIL_UNAVAILABLE')));
      const user = await ready();
      const form = within(emailForm());
      await user.type(form.getByLabelText('New email'), 'taken@printout.test');
      await user.type(form.getByLabelText('Confirm new email'), 'taken@printout.test');
      await user.type(form.getByLabelText('Current password'), 'my-current-pass');
      await user.click(form.getByRole('button', { name: 'Change email' }));
      expect(await form.findByText('This email address cannot be used. Choose a different one.')).toBeInTheDocument();
      expect(form.getByLabelText('New email')).toHaveFocus();
    });

    it('announces rate limiting and server failures in a focused alert', async () => {
      mockFetch(authed, accountGet, reply('/admin/account/email', apiError(429, 'RATE_LIMITED')));
      const user = await ready();
      const form = within(emailForm());
      await user.type(form.getByLabelText('New email'), 'new@printout.test');
      await user.type(form.getByLabelText('Confirm new email'), 'new@printout.test');
      await user.type(form.getByLabelText('Current password'), 'my-current-pass');
      await user.click(form.getByRole('button', { name: 'Change email' }));
      const alert = await form.findByRole('alert');
      expect(alert).toHaveTextContent(/too many attempts/i);
      await waitFor(() => expect(alert.parentElement).toHaveFocus());
    });

    it('disables the form and shows progress while saving, preventing double submits', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const { fn } = mockFetch(authed, accountGet);
      const original = fn.getMockImplementation()!;
      fn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/admin/account/email')) { await gate; return new Response(JSON.stringify({ data: { email: 'n@printout.test', signedOut: true } }), { status: 200 }); }
        return original(input, init);
      });
      const user = await ready();
      const form = within(emailForm());
      await user.type(form.getByLabelText('New email'), 'new@printout.test');
      await user.type(form.getByLabelText('Confirm new email'), 'new@printout.test');
      await user.type(form.getByLabelText('Current password'), 'my-current-pass{Enter}');
      await waitFor(() => expect(form.getByLabelText('New email')).toBeDisabled());
      await user.keyboard('{Enter}');
      release();
      await screen.findByRole('heading', { name: 'Admin sign in' });
      expect(fn.mock.calls.filter(([u]) => String(u).endsWith('/admin/account/email'))).toHaveLength(1);
    });
  });

  describe('change password', () => {
    async function fill(user: ReturnType<typeof userEvent.setup>, current: string, next: string, confirm: string) {
      const form = within(passwordForm());
      if (current) await user.type(form.getByLabelText('Current password'), current);
      if (next) await user.type(form.getByLabelText('New password'), next);
      if (confirm) await user.type(form.getByLabelText('Confirm new password'), confirm);
      return form;
    }

    it('validates required fields, length, reuse, email-name and confirmation without calling the API', async () => {
      const { calls } = mockFetch(authed, accountGet);
      const user = await ready();
      const form = within(passwordForm());
      const submit = () => user.click(form.getByRole('button', { name: 'Change password' }));
      await submit();
      expect(form.getByText('Enter your current password.')).toBeInTheDocument();
      expect(form.getByLabelText('Current password')).toHaveFocus();

      await user.type(form.getByLabelText('Current password'), 'old-password-123');
      await user.type(form.getByLabelText('New password'), 'short');
      await submit();
      expect(form.getByText('Use at least 12 characters.')).toBeInTheDocument();
      expect(form.getByLabelText('New password')).toHaveFocus();

      await user.clear(form.getByLabelText('New password'));
      await user.type(form.getByLabelText('New password'), 'old-password-123');
      await submit();
      expect(form.getByText('The new password must be different from the current one.')).toBeInTheDocument();

      await user.clear(form.getByLabelText('New password'));
      await user.type(form.getByLabelText('New password'), 'my-root-password-9');
      await submit();
      expect(form.getByText('The password must not contain your email name.')).toBeInTheDocument();

      await user.clear(form.getByLabelText('New password'));
      await user.type(form.getByLabelText('New password'), 'a-fresh-passphrase-42');
      await user.type(form.getByLabelText('Confirm new password'), 'a-different-one-42');
      await submit();
      expect(form.getByText('The passwords do not match.')).toBeInTheDocument();
      expect(form.getByLabelText('Confirm new password')).toHaveFocus();
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('clears a field error as soon as the user edits that field', async () => {
      mockFetch(authed, accountGet);
      const user = await ready();
      const form = within(passwordForm());
      await user.click(form.getByRole('button', { name: 'Change password' }));
      expect(form.getByText('Enter your current password.')).toBeInTheDocument();
      await user.type(form.getByLabelText('Current password'), 'x');
      expect(form.queryByText('Enter your current password.')).not.toBeInTheDocument();
    });

    it('changes the password, ends the session locally and explains it on the sign-in page', async () => {
      const { calls } = mockFetch(authed, accountGet, reply('/admin/account/password', { data: { signedOut: true } }));
      const user = await ready();
      const form = await fill(user, 'old-password-123', 'a-fresh-passphrase-42', 'a-fresh-passphrase-42');
      await user.click(form.getByRole('button', { name: 'Change password' }));
      expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/password was changed and you were signed out on all devices/i);
      expect(calls.find((c) => c.path === '/admin/account/password')!.body).toEqual({ currentPassword: 'old-password-123', newPassword: 'a-fresh-passphrase-42' });
      // The stale session is gone: protected admin routes now send the user to sign in.
      expect(screen.getByLabelText('Email')).toHaveValue('');
      expect(document.body.textContent).not.toContain('a-fresh-passphrase-42');
    });

    it('a 401 after the change (session already ended server-side) is reported as an expired session', async () => {
      mockFetch(authed, accountGet, reply('/admin/account/password', apiError(401, 'UNAUTHORIZED')));
      const user = await ready();
      const form = await fill(user, 'old-password-123', 'a-fresh-passphrase-42', 'a-fresh-passphrase-42');
      await user.click(form.getByRole('button', { name: 'Change password' }));
      expect(await screen.findByText('Session expired — sign in again.')).toBeInTheDocument();
    });

    it('maps a wrong current password and a server-side policy rejection to the right fields', async () => {
      let n = 0;
      mockFetch(authed, accountGet, ({ method, path }) => {
        if (method !== 'POST' || path !== '/admin/account/password') return undefined;
        return ++n === 1 ? apiError(403, 'INVALID_CURRENT_PASSWORD') : apiError(400, 'VALIDATION_ERROR', 'New password is a commonly used password');
      });
      const user = await ready();
      const form = await fill(user, 'old-password-123', 'a-fresh-passphrase-42', 'a-fresh-passphrase-42');
      await user.click(form.getByRole('button', { name: 'Change password' }));
      expect(await form.findByText('Current password is incorrect.')).toBeInTheDocument();
      expect(form.getByLabelText('Current password')).toHaveFocus();
      await user.type(form.getByLabelText('Current password'), 'old-password-123');
      await user.click(form.getByRole('button', { name: 'Change password' }));
      expect(await form.findByText('New password is a commonly used password')).toBeInTheDocument();
      expect(form.getByLabelText('New password')).toHaveFocus();
    });

    it('reveals and hides a password with the keyboard-operable toggle, keeping the value', async () => {
      mockFetch(authed, accountGet);
      const user = await ready();
      const form = within(passwordForm());
      const field = form.getByLabelText('New password');
      await user.type(field, 'visible-secret-1');
      const toggle = form.getByRole('button', { name: 'Show new password' });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      expect(field).toHaveAttribute('type', 'password');
      toggle.focus();
      await user.keyboard(' ');
      expect(field).toHaveAttribute('type', 'text');
      expect(form.getByRole('button', { name: 'Hide new password' })).toHaveAttribute('aria-pressed', 'true');
      expect(field).toHaveValue('visible-secret-1');
      await user.keyboard('{Enter}');
      expect(field).toHaveAttribute('type', 'password');
    });

    it('keeps a logical tab order inside the form and never submits when the toggle is pressed', async () => {
      const { calls } = mockFetch(authed, accountGet);
      const user = await ready();
      const form = within(passwordForm());
      form.getByLabelText('Current password').focus();
      await user.tab();
      expect(form.getByRole('button', { name: 'Show current password' })).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
      await user.tab();
      expect(form.getByLabelText('New password')).toHaveFocus();
    });
  });

  it('signs out from the session card', async () => {
    const { calls } = mockFetch(authed, accountGet, reply('/auth/logout', { status: 204 }));
    const user = await ready();
    await user.click(within(screen.getByRole('region', { name: 'Current session' })).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/auth/logout')).toBe(true);
  });

  it('uses labelled landmarks and exactly one h1', async () => {
    mockFetch(authed, accountGet);
    await ready();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    for (const name of ['Account details', 'Current session', 'Change email', 'Change password']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });
});
