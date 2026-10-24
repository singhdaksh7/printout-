import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setGoogleAuthFactory, PhoneAuthError } from '../../lib/phone-auth';
import { setCsrfToken } from '../../lib/api';
import { FakeES, emptyList, mockFetch, renderShop, session, type Handler } from './helpers';
import { safeShopRedirect } from '../safe-redirect';

beforeEach(() => {
  FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null);
  vi.stubEnv('VITE_PHONE_AUTH_MOCK', '1');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); __setGoogleAuthFactory(null); vi.useRealTimers(); });

/** Unauthenticated API with session exchange handlers. */
function api(googleExchange?: Handler, loginExchange?: Handler) {
  let signedIn = false;
  return mockFetch(
    ({ method, path }) => (method === 'GET' && path === '/auth/session' && !signedIn ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
    (req) => {
      if (req.method === 'POST' && req.path === '/auth/google/session') {
        const r = googleExchange ? googleExchange(req) : { data: session() };
        if (r && !r.error) signedIn = true;
        return r;
      }
      if (req.method === 'POST' && req.path === '/auth/login') {
        const r = loginExchange ? loginExchange(req) : { data: session() };
        if (r && !r.error) signedIn = true;
        return r;
      }
      return undefined;
    },
    ({ method, path }) => (method === 'GET' && path === '/auth/session' && signedIn ? { data: session() } : undefined),
    emptyList
  );
}

describe('simplified shop login screen (Google + Email/Password only)', () => {
  it('renders Email & Password by default, with Continue with Google clearly visible', async () => {
    api();
    renderShop('/shop/login');
    expect(await screen.findByRole('heading', { name: /shop sign in/i })).toBeInTheDocument();
    expect(screen.getByText('Printout for print shops')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('Phone OTP login is completely absent from the website UI', async () => {
    api();
    renderShop('/shop/login');
    await screen.findByRole('heading', { name: /shop sign in/i });

    // Phone form is completely absent
    expect(screen.queryByTestId('phone-login')).toBeNull();
    // Country code selector is absent
    expect(screen.queryByLabelText(/country code/i)).toBeNull();
    // Send OTP button is absent
    expect(screen.queryByRole('button', { name: /send otp/i })).toBeNull();
    // OTP verification boxes are absent
    expect(screen.queryByTestId('otp-group')).toBeNull();
    // Tabs or toggles between Phone and Email are absent
    expect(screen.queryByRole('button', { name: /sign in with email and password instead/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /sign in with mobile number instead/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /phone/i })).toBeNull();
  });

  it('signs in with email and password successfully', async () => {
    const user = userEvent.setup();
    const { calls } = api();
    renderShop('/shop/login');
    await screen.findByRole('heading', { name: /shop sign in/i });

    await user.type(screen.getByLabelText('Email'), 'owner@central.test');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Print queue' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({
      email: 'owner@central.test',
      password: 'password123'
    });
  });

  it('Continue with Google: exchanges ID token and lands in the shop', async () => {
    const user = userEvent.setup();
    let googleTokenSent = '';
    api((req) => {
      googleTokenSent = (req.body as any)?.idToken;
      return { data: session() };
    });
    __setGoogleAuthFactory(async () => 'google-test-id-token');

    renderShop('/shop/login');
    const googleBtn = await screen.findByRole('button', { name: 'Continue with Google' });
    expect(googleBtn).toBeInTheDocument();
    await user.click(googleBtn);

    expect(await screen.findByRole('heading', { name: 'Print queue' })).toBeInTheDocument();
    expect(googleTokenSent).toBe('google-test-id-token');
  });

  it('Continue with Google: shows friendly error when Google account is unlinked', async () => {
    const user = userEvent.setup();
    api(() => ({ status: 403, error: { code: 'GOOGLE_NOT_LINKED' } }));
    __setGoogleAuthFactory(async () => 'google-unlinked-token');

    renderShop('/shop/login');
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByText(/This Google account isn't linked to a shop account\. Sign in with email and password, then link it in Settings\./i)).toBeInTheDocument();
  });

  it('Continue with Google: shows clear guidance when popup was blocked by browser', async () => {
    const user = userEvent.setup();
    api();
    __setGoogleAuthFactory(async () => {
      throw new PhoneAuthError('popup-blocked', 'popup-blocked');
    });

    renderShop('/shop/login');
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByText(/The Google sign-in popup was blocked by your browser\. Please allow popups for this site and try again\./i)).toBeInTheDocument();
  });

  it('Continue with Google: shows safe message when user cancelled sign-in', async () => {
    const user = userEvent.setup();
    api();
    __setGoogleAuthFactory(async () => {
      throw new PhoneAuthError('cancelled', 'cancelled');
    });

    renderShop('/shop/login');
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByText(/Google sign-in was cancelled\./i)).toBeInTheDocument();
  });
});

describe('safeShopRedirect', () => {
  it.each([
    ['/shop', '/shop'], ['/shop/orders/12?x=1', '/shop/orders/12?x=1'], ['/shop/settings#a', '/shop/settings#a'],
    [undefined, '/shop'], ['', '/shop'], ['/shop/login', '/shop'], ['/shop/login?x=1', '/shop'],
    ['//evil.com', '/shop'], ['/\\evil.com', '/shop'], ['https://evil.com', '/shop'], ['/shopx', '/shop'],
    ['/shop//evil.com', '/shop'], ['/shop\\..\\evil', '/shop'], ['javascript:alert(1)', '/shop'], ['/admin', '/shop']
  ])('%s -> %s', (input, out) => { expect(safeShopRedirect(input as string | undefined)).toBe(out); });
});
