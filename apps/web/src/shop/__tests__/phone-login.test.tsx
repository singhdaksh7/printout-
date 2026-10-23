import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setGoogleAuthFactory, __setPhoneAuthFactory, PhoneAuthError, type PhoneAuthProvider } from '../../lib/phone-auth';
import { setCsrfToken } from '../../lib/api';
import { FakeES, emptyList, mockFetch, renderShop, session, type Handler } from './helpers';
import { safeShopRedirect } from '../safe-redirect';

beforeEach(() => {
  FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null);
  vi.stubEnv('VITE_PHONE_AUTH_MOCK', '1');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); __setPhoneAuthFactory(null); __setGoogleAuthFactory(null); vi.useRealTimers(); });

const CONFIG = { enabled: true, allowedCallingCodes: ['+91', '+1'], defaultCallingCode: '+91', resendCooldownSeconds: 30 };

function provider(over: Partial<PhoneAuthProvider> = {}) {
  const p = {
    sendCode: vi.fn(async () => undefined),
    confirm: vi.fn(async () => 'firebase-id-token'),
    reset: vi.fn(),
    ...over
  };
  __setPhoneAuthFactory(async () => p);
  return p;
}

/** Unauthenticated API with phone sign-in on; `exchange` answers POST /auth/phone/session. */
function api(exchange: Handler = () => ({ data: session() }), config: unknown = CONFIG) {
  let signedIn = false;
  const m = mockFetch(
    ({ method, path }) => (method === 'GET' && path === '/auth/session' && !signedIn ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
    ({ method, path }) => (method === 'GET' && path === '/auth/phone/config' ? (config === 'fail' ? { status: 500, error: { code: 'X' } } : { data: config }) : undefined),
    (req) => {
      if (req.method === 'POST' && req.path === '/auth/phone/session') {
        const r = exchange(req);
        if (r && !r.error) signedIn = true;
        return r;
      }
      return undefined;
    },
    ({ method, path }) => (method === 'GET' && path === '/auth/session' && signedIn ? { data: session() } : undefined),
    emptyList
  );
  return m;
}

async function enterNumber(user: ReturnType<typeof userEvent.setup>, n = '98765 43210') {
  await user.type(await screen.findByLabelText('Mobile number'), n);
  await user.click(screen.getByRole('button', { name: 'Send OTP' }));
}
async function tick(seconds: number) { for (let i = 0; i < seconds; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); }
const boxes = () => within(screen.getByTestId('otp-group')).getAllByRole('textbox');

describe('phone sign-in screens', () => {
  it('screen 1: logo, Welcome back, India (+91) default, consent text and email fallback', async () => {
    api(); provider();
    renderShop('/shop');
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText('Country code')).toHaveValue('+91');
    expect(screen.getByRole('option', { name: /India \(\+91\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /United States \/ Canada \(\+1\)/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /United Kingdom/ })).toBeNull(); // not in allowedCallingCodes
    expect(screen.getByText(/one-time SMS code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send OTP' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with email and password instead' })).toBeInTheDocument();
  });

  it('valid OTP login: sends E.164, verifies, exchanges the ID token only, lands in the shop', async () => {
    const user = userEvent.setup();
    const { calls } = api();
    const p = provider();
    renderShop('/shop');
    await enterNumber(user);
    expect(p.sendCode).toHaveBeenCalledWith('+919876543210');
    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument();
    expect(screen.getAllByText(/\+91••••••3210/).length).toBeGreaterThan(0);
    await user.keyboard('123456'); // focus starts on the first box
    expect(await screen.findByRole('heading', { name: 'Print queue' })).toBeInTheDocument();
    expect(p.confirm).toHaveBeenCalledWith('123456');
    const call = calls.find((c) => c.path === '/auth/phone/session')!;
    expect(call.body).toEqual({ idToken: 'firebase-id-token' });
  });

  it('rejects an invalid number locally without contacting Firebase', async () => {
    const user = userEvent.setup();
    api(); const p = provider();
    renderShop('/shop');
    await enterNumber(user, '12345');
    expect(await screen.findByText(/valid 10-digit mobile number/i)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Mobile number'));
    await user.type(screen.getByLabelText('Mobile number'), '5876543210');
    await user.click(screen.getByRole('button', { name: 'Send OTP' }));
    expect(await screen.findByText(/start with 6, 7, 8 or 9/i)).toBeInTheDocument();
    expect(p.sendCode).not.toHaveBeenCalled();
  });

  it('invalid code: shows an alert, clears the boxes and keeps the person on the code screen', async () => {
    const user = userEvent.setup();
    api();
    provider({ confirm: vi.fn(async () => { throw new PhoneAuthError('code-invalid', 'x'); }) });
    renderShop('/shop');
    await enterNumber(user);
    await screen.findByRole('heading', { name: 'Enter your code' });
    await user.keyboard('000000');
    expect(await screen.findByTestId('phone-error')).toHaveTextContent(/not correct/i);
    await waitFor(() => expect(boxes().every((b) => (b as HTMLInputElement).value === '')).toBe(true));
    expect(boxes()[0]).toHaveFocus();
  });

  it('expired code asks for a new one and enables resend immediately', async () => {
    const user = userEvent.setup();
    api();
    provider({ confirm: vi.fn(async () => { throw new PhoneAuthError('code-expired', 'x'); }) });
    renderShop('/shop');
    await enterNumber(user);
    await screen.findByRole('heading', { name: 'Enter your code' });
    await user.keyboard('123456');
    expect(await screen.findByTestId('phone-error')).toHaveTextContent(/expired/i);
    expect(screen.getByRole('button', { name: 'Resend OTP' })).toBeEnabled();
  });

  it('a number that is not linked returns to screen 1 with guidance (server refusal, not enumeration of others)', async () => {
    const user = userEvent.setup();
    api(() => ({ status: 403, error: { code: 'PHONE_NOT_LINKED' } }));
    provider();
    renderShop('/shop');
    await enterNumber(user);
    await screen.findByRole('heading', { name: 'Enter your code' });
    await user.keyboard('123456');
    expect(await screen.findByTestId('phone-error')).toHaveTextContent("This number isn't linked to a shop account. Sign in with email and password, then link it in Settings.");
    expect(await screen.findByLabelText('Mobile number')).toBeInTheDocument();
  });

  it('server rate limit keeps the code screen so the same verified token can be retried', async () => {
    const user = userEvent.setup();
    let n = 0;
    api(() => (++n === 1 ? { status: 429, error: { code: 'RATE_LIMITED' } } : { data: session() }));
    const p = provider();
    renderShop('/shop');
    await enterNumber(user);
    await screen.findByRole('heading', { name: 'Enter your code' });
    await user.keyboard('123456');
    expect(await screen.findByTestId('phone-error')).toHaveTextContent(/too many sign-in attempts/i);
    await user.click(screen.getByRole('button', { name: 'Verify OTP' }));
    expect(await screen.findByRole('heading', { name: 'Print queue' })).toBeInTheDocument();
    expect(p.confirm).toHaveBeenCalledTimes(1); // the consumed OTP is not re-sent to Firebase
  });

  it.each([
    ['captcha', /could not verify this device/i],
    ['unavailable', /unavailable right now/i],
    ['network', /cannot reach the verification service/i],
    ['quota', /cannot send more codes/i],
    ['rate-limited', /too many attempts/i],
    ['region-blocked', /cannot be sent to this country/i],
    ['domain', /not available on this address/i]
  ] as const)('Firebase sendCode failure "%s" shows a safe message and stays on screen 1', async (kind, re) => {
    const user = userEvent.setup();
    api();
    provider({ sendCode: vi.fn(async () => { throw new PhoneAuthError(kind, 'auth/raw-sdk-text-secret'); }) });
    renderShop('/shop');
    await enterNumber(user);
    const err = await screen.findByTestId('phone-error');
    expect(err).toHaveTextContent(re);
    expect(err).not.toHaveTextContent('auth/raw-sdk-text-secret');
    expect(screen.getByLabelText('Mobile number')).toHaveValue('98765 43210');
  });

  it('resend has a 30s cooldown and at most 3 resends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    api();
    const p = provider();
    renderShop('/shop');
    await enterNumber(user);
    await screen.findByRole('heading', { name: 'Enter your code' });
    expect(screen.getByRole('button', { name: 'Resend OTP in 30s' })).toBeDisabled();
    await tick(10);
    expect(screen.getByRole('button', { name: /Resend OTP in (19|20|21)s/ })).toBeDisabled();
    for (let i = 1; i <= 3; i++) {
      await tick(31);
      await user.click(await screen.findByRole('button', { name: 'Resend OTP' }));
      await waitFor(() => expect(p.sendCode).toHaveBeenCalledTimes(i + 1));
    }
    await tick(31);
    expect(screen.getByRole('button', { name: 'No more resends' })).toBeDisabled();
    expect(p.reset).toHaveBeenCalled(); // reCAPTCHA is re-created for every send
  });

  it('change phone number returns to screen 1 and discards the pending verification', async () => {
    const user = userEvent.setup();
    api(); const p = provider();
    renderShop('/shop');
    await enterNumber(user);
    await screen.findByRole('heading', { name: 'Enter your code' });
    await user.click(screen.getByRole('button', { name: 'Change phone number' }));
    expect(await screen.findByLabelText('Mobile number')).toBeInTheDocument();
    expect(p.reset).toHaveBeenCalled();
  });

  it('paste fills all six boxes and submits; backspace and arrow keys move between boxes', async () => {
    const user = userEvent.setup();
    api();
    const p = provider();
    renderShop('/shop');
    await enterNumber(user);
    await screen.findByRole('heading', { name: 'Enter your code' });
    await user.keyboard('12');
    expect(boxes().map((b) => (b as HTMLInputElement).value).join('')).toBe('12');
    expect(boxes()[2]).toHaveFocus();
    await user.keyboard('{Backspace}');
    expect(boxes()[1]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(boxes()[0]).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(boxes()[2]).toHaveFocus();
    await user.click(boxes()[0]!);
    await user.paste('123 456');
    await waitFor(() => expect(p.confirm).toHaveBeenCalledWith('123456'));
  });

  it('every OTP box and control is labelled for keyboard and screen-reader users', async () => {
    const user = userEvent.setup();
    api(); provider();
    renderShop('/shop');
    await enterNumber(user);
    await screen.findByRole('heading', { name: 'Enter your code' });
    expect(screen.getByRole('group', { name: '6-digit verification code' })).toBeInTheDocument();
    expect(screen.getByLabelText('Digit 1 of 6')).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByLabelText('Digit 6 of 6')).toBeInTheDocument();
  });

  it('email/password fallback is one click away and still signs in', async () => {
    const user = userEvent.setup();
    let loggedIn = false;
    const m = mockFetch(
      ({ method, path }) => (method === 'GET' && path === '/auth/session' && !loggedIn ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
      ({ path }) => (path === '/auth/phone/config' ? { data: CONFIG } : undefined),
      ({ method, path }) => { if (method === 'POST' && path === '/auth/login') { loggedIn = true; return { data: session() }; } return undefined; },
      emptyList
    );
    provider();
    renderShop('/shop');
    await user.click(await screen.findByRole('button', { name: 'Sign in with email and password instead' }));
    expect(await screen.findByRole('heading', { name: /shop sign in/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'owner@central.test');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Print queue' })).toBeInTheDocument();
    expect(m.calls.find((c) => c.path === '/auth/login')?.body).toEqual({ email: 'owner@central.test', password: 'password123' });
    // and back again
  });

  it('falls back to the email form when the phone config cannot be loaded (outage) or is disabled', async () => {
    api(undefined, 'fail'); provider();
    renderShop('/shop');
    expect(await screen.findByRole('heading', { name: /shop sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mobile number instead/i })).toBeNull();
    cleanup();
    api(undefined, { ...CONFIG, enabled: false });
    renderShop('/shop');
    expect(await screen.findByRole('heading', { name: /shop sign in/i })).toBeInTheDocument();
  });

  it('Google sign-in: clicks Continue with Google, exchanges token via /auth/google/session, lands in the shop', async () => {
    const user = userEvent.setup();
    let signedIn = false;
    let googleTokenSent = '';
    mockFetch(
      ({ method, path }) => (method === 'GET' && path === '/auth/session' && !signedIn ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
      ({ path }) => (path === '/auth/phone/config' ? { data: CONFIG } : undefined),
      (req) => {
        if (req.method === 'POST' && req.path === '/auth/google/session') {
          signedIn = true;
          googleTokenSent = (req.body as any)?.idToken;
          return { data: session() };
        }
        return undefined;
      },
      ({ method, path }) => (method === 'GET' && path === '/auth/session' && signedIn ? { data: session() } : undefined),
      emptyList
    );
    __setGoogleAuthFactory(async () => 'google-test-id-token');
    provider();
    renderShop('/shop');
    const googleBtn = await screen.findByRole('button', { name: 'Continue with Google' });
    expect(googleBtn).toBeInTheDocument();
    await user.click(googleBtn);
    expect(await screen.findByRole('heading', { name: 'Print queue' })).toBeInTheDocument();
    expect(googleTokenSent).toBe('google-test-id-token');
  });

  it('Google sign-in: shows friendly error when unlinked', async () => {
    const user = userEvent.setup();
    mockFetch(
      ({ method, path }) => (method === 'GET' && path === '/auth/session' ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
      ({ path }) => (path === '/auth/phone/config' ? { data: CONFIG } : undefined),
      (req) => {
        if (req.method === 'POST' && req.path === '/auth/google/session') {
          return { status: 403, error: { code: 'GOOGLE_NOT_LINKED' } };
        }
        return undefined;
      },
      emptyList
    );
    __setGoogleAuthFactory(async () => 'google-unlinked-token');
    provider();
    renderShop('/shop');
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByText(/This Google account isn't linked to a shop account/i)).toBeInTheDocument();
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
