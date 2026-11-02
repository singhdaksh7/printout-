import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, emptyList, mockFetch, renderShop, session } from './helpers';
import { getCsrfToken, setCsrfToken } from '../../lib/api';
import { __setGoogleAuthFactory } from '../../lib/phone-auth';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); vi.stubEnv('VITE_PHONE_AUTH_MOCK', '1'); __setGoogleAuthFactory(async () => 'google-token'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); __setGoogleAuthFactory(null); });

const unauth = ({ method, path }: { method: string; path: string }) =>
  method === 'GET' && path === '/auth/session' ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined;

describe('shop auth', () => {
  it('redirects unauthenticated users to login, preserving destination, then returns after Google sign-in', async () => {
    const user = userEvent.setup();
    let loggedIn = false;
    const { calls } = mockFetch(
      ({ method, path }) => (method === 'GET' && path === '/auth/session' && !loggedIn ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
      ({ method, path }) => { if (method === 'POST' && path === '/auth/google/session') { loggedIn = true; return { data: session() }; } return undefined; },
      emptyList,
      ({ path }) => (path === '/shop/pricing-rules' ? { data: [] } : undefined)
    );
    renderShop('/shop/pricing');
    expect(await screen.findByRole('heading', { name: /shop sign in/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByRole('heading', { name: 'Rate card' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/google/session')?.body).toEqual({ idToken: 'google-token' });
    expect(getCsrfToken()).toBe('csrf-1');
  });

  it('shows only Continue with Google: no email, password or manual sign-in button', async () => {
    mockFetch(unauth);
    renderShop('/shop/login');
    await screen.findByRole('heading', { name: /shop sign in/i });
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('shows a rate-limit message on 429', async () => {
    const user = userEvent.setup();
    mockFetch(unauth, ({ method, path }) => (method === 'POST' && path === '/auth/google/session' ? { status: 429, error: { code: 'RATE_LIMITED' } } : undefined));
    renderShop('/shop');
    await screen.findByRole('heading', { name: /shop sign in/i });
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many sign-in attempts/i);
  });

  it('never redirects an administrator session into /admin: shows a notice with an explicit link', async () => {
    mockFetch(({ path }) => (path === '/auth/session' ? { data: session({ user: { id: 'a', displayName: 'Admin', role: 'PLATFORM_ADMIN' }, shop: null }) } : undefined));
    renderShop('/shop');
    expect(await screen.findByRole('heading', { name: 'Administrator account' })).toBeInTheDocument();
    expect(screen.queryByText('ADMIN AREA')).toBeNull();
    expect(screen.getByRole('link', { name: /admin console/i })).toHaveAttribute('href', '/admin');
    expect(screen.getByTestId('where')).toHaveTextContent('/shop');
  });

  it('shop login and unknown shop paths never land on an admin route', async () => {
    mockFetch(unauth);
    renderShop('/shop/nonsense');
    await screen.findByRole('heading', { name: /shop sign in/i });
    expect(screen.getByTestId('where').textContent).not.toMatch(/admin/);
  });

  it('handles a 401 mid-session on Refresh and asks to sign in again', async () => {
    let expire = false;
    mockFetch(
      ({ method, path }) => (method === 'GET' && path === '/auth/session' && expire ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
      ({ method, path }) => (method === 'GET' && path === '/shop/orders' && expire ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
      authedSession, emptyList
    );
    renderShop('/shop');
    await screen.findByRole('heading', { name: 'Print queue' });
    expire = true;
    await userEvent.click(await screen.findByTestId('queue-refresh'));
    expect(await screen.findByText('Session expired — sign in again.')).toBeInTheDocument();
    expect(FakeES.open).toHaveLength(0);
  });

  it('logs out via POST /auth/logout with the CSRF token', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, emptyList, ({ method, path }) => (method === 'POST' && path === '/auth/logout' ? { status: 204 } : undefined));
    renderShop('/shop');
    await screen.findByRole('heading', { name: 'Print queue' });
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { name: /shop sign in/i })).toBeInTheDocument();
    const call = calls.find((c) => c.path === '/auth/logout')!;
    expect(call.method).toBe('POST');
    expect(call.headers['x-csrf-token']).toBe('csrf-1');
    expect(FakeES.open).toHaveLength(0);
  });
});
