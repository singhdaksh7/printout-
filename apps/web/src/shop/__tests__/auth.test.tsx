import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, emptyList, mockFetch, renderShop, session } from './helpers';
import { getCsrfToken, setCsrfToken } from '../../lib/api';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const unauth = ({ method, path }: { method: string; path: string }) =>
  method === 'GET' && path === '/auth/session' ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined;

describe('shop auth', () => {
  it('redirects unauthenticated users to login, preserving destination, then returns after login', async () => {
    const user = userEvent.setup();
    let loggedIn = false;
    const { calls } = mockFetch(
      ({ method, path }) => (method === 'GET' && path === '/auth/session' && !loggedIn ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
      ({ method, path }) => { if (method === 'POST' && path === '/auth/login') { loggedIn = true; return { data: session() }; } return undefined; },
      emptyList,
      ({ path }) => (path === '/shop/pricing-rules' ? { data: [] } : undefined)
    );
    renderShop('/shop/pricing');
    expect(await screen.findByRole('heading', { name: /shop sign in/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'owner@central.test');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Pricing' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ email: 'owner@central.test', password: 'password123' });
    expect(getCsrfToken()).toBe('csrf-1');
  });

  it('shows a generic error for wrong credentials and a loading state while submitting', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mockFetch(unauth, ({ method, path }) => (method === 'POST' && path === '/auth/login' ? { status: 401, error: { code: 'INVALID_CREDENTIALS', message: 'No such user bob@x.com' } } : undefined));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => { if (String(a[0]).includes('/auth/login')) await gate; return realFetch(...a); });
    renderShop('/shop');
    await screen.findByRole('heading', { name: /shop sign in/i });
    await user.type(screen.getByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'wrongpass1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const busy = await screen.findByRole('button', { name: /signing in/i });
    expect(busy).toBeDisabled();
    release();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Incorrect email or password.');
    expect(alert).not.toHaveTextContent('bob@x.com');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows a rate-limit message on 429', async () => {
    const user = userEvent.setup();
    mockFetch(unauth, ({ method, path }) => (method === 'POST' && path === '/auth/login' ? { status: 429, error: { code: 'RATE_LIMITED' } } : undefined));
    renderShop('/shop');
    await screen.findByRole('heading', { name: /shop sign in/i });
    await user.type(screen.getByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'wrongpass1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many sign-in attempts/i);
  });

  it('sends platform admins to /admin', async () => {
    mockFetch(({ path }) => (path === '/auth/session' ? { data: session({ user: { id: 'a', displayName: 'Admin', role: 'PLATFORM_ADMIN' }, shop: null }) } : undefined));
    renderShop('/shop');
    expect(await screen.findByText('ADMIN AREA')).toBeInTheDocument();
  });

  it('handles a 401 mid-session: closes SSE and asks to sign in again', async () => {
    let expire = false;
    mockFetch(
      ({ method, path }) => (method === 'GET' && path === '/auth/session' && expire ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
      ({ method, path }) => (method === 'GET' && path === '/shop/orders' && expire ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
      authedSession, emptyList
    );
    renderShop('/shop');
    await screen.findByRole('heading', { name: 'Print queue' });
    await waitFor(() => expect(FakeES.open).toHaveLength(1));
    expire = true;
    // a focus event triggers the safety-net refetch, which now returns 401
    window.dispatchEvent(new Event('focus'));
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
