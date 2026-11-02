import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setGoogleAuthFactory } from '../../lib/phone-auth';
import { setCsrfToken } from '../../lib/api';
import { FakeES, emptyList, mockFetch, renderShop, session, type Handler } from './helpers';

beforeEach(() => {
  FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null);
  vi.stubEnv('VITE_PHONE_AUTH_MOCK', '1');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); __setGoogleAuthFactory(null); });

function api(recover?: Handler) {
  let signedIn = false;
  return mockFetch(
    ({ method, path }) => (method === 'GET' && path === '/auth/session' && !signedIn ? { status: 401, error: { code: 'UNAUTHENTICATED' } } : undefined),
    (req) => {
      if (req.method === 'POST' && req.path === '/auth/google/recover') {
        const r = recover ? recover(req) : { data: session() };
        if (r && !r.error) signedIn = true;
        return r;
      }
      return undefined;
    },
    ({ method, path }) => (method === 'GET' && path === '/auth/session' && signedIn ? { data: session() } : undefined),
    emptyList
  );
}

async function toStepTwo(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Old email'), 'owner@old.test');
  await user.type(screen.getByLabelText('Old password'), 'old-password-123');
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

describe('legacy owner recovery page', () => {
  it('login page stays Google-only and only offers a small recovery link', async () => {
    api();
    renderShop('/shop/login');
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    expect(screen.getByTestId('recover-link')).toHaveAttribute('href', '/shop/recover');
  });

  it('two steps: password first, then Google; sends both proofs and leaves the page', async () => {
    const user = userEvent.setup();
    let body: unknown;
    api((req) => { body = req.body; return { data: session() }; });
    __setGoogleAuthFactory(async () => 'google-test-id-token-0123456789');
    renderShop('/shop/recover');
    expect(await screen.findByRole('heading', { name: /recover access/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
    await toStepTwo(user);
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(body).toEqual({ email: 'owner@old.test', password: 'old-password-123', idToken: 'google-test-id-token-0123456789' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /recover access/i })).toBeNull());
  });

  it('shows a clear error and returns to step 1 on a wrong password', async () => {
    const user = userEvent.setup();
    api(() => ({ status: 401, error: { code: 'INVALID_CREDENTIALS' } }));
    __setGoogleAuthFactory(async () => 'google-test-id-token-0123456789');
    renderShop('/shop/recover');
    await toStepTwo(user);
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByText(/do not match a shop owner account/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Old email')).toBeInTheDocument();
  });

  it.each([
    [429, 'RATE_LIMITED', /too many attempts/i],
    [409, 'GOOGLE_IDENTITY_UNAVAILABLE', /already linked to a different account/i],
    [503, 'GOOGLE_LOGIN_UNAVAILABLE', /unavailable/i]
  ])('maps %s %s to a readable message', async (status, code, text) => {
    const user = userEvent.setup();
    api(() => ({ status, error: { code } }));
    __setGoogleAuthFactory(async () => 'google-test-id-token-0123456789');
    renderShop('/shop/recover');
    await toStepTwo(user);
    await user.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });
});
