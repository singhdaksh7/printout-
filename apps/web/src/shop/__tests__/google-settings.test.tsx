import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setGoogleAuthFactory, PhoneAuthError } from '../../lib/phone-auth';
import { setCsrfToken } from '../../lib/api';
import { FakeES, authedSession, emptyList, mockFetch, renderShop, type Handler } from './helpers';

beforeEach(() => {
  FakeES.reset();
  vi.stubGlobal('EventSource', FakeES);
  setCsrfToken(null);
  vi.stubEnv('VITE_PHONE_AUTH_MOCK', '1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __setGoogleAuthFactory(null);
});

const settings: Handler = ({ method, path }) =>
  method === 'GET' && path === '/shop/settings' ? { data: { displayName: 'Central', publicContact: '' } } : undefined;

function setup(identities: unknown, ...extra: Handler[]) {
  const m = mockFetch(
    authedSession,
    emptyList,
    settings,
    ...extra,
    ({ method, path }) => (method === 'GET' && path === '/users/me/identities' ? { data: identities } : undefined)
  );
  return m;
}

describe('Settings > Google sign-in account linking', () => {
  it('hidden when the server does not support the identities endpoint (404)', async () => {
    mockFetch(authedSession, emptyList, settings, ({ path }) =>
      path === '/users/me/identities' ? { status: 404, error: { code: 'NOT_FOUND' } } : undefined
    );
    renderShop('/shop/settings');
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByTestId('google-account-section')).toBeNull();
  });

  it('hidden when Google sign-in is disabled on the server and no Google account is linked', async () => {
    setup({ password: { set: true }, phone: { linked: false }, google: { linked: false }, googleAvailable: false });
    renderShop('/shop/settings');
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByTestId('google-account-section')).toBeNull();
  });

  it('shows unlinked status with Link Google account button', async () => {
    setup({ password: { set: true }, phone: { linked: false }, google: { linked: false }, googleAvailable: true });
    renderShop('/shop/settings');
    await screen.findByRole('heading', { name: 'Settings' });
    const section = await screen.findByTestId('google-account-section');
    expect(within(section).getByText('No Google account linked.')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Link Google account' })).toBeInTheDocument();
  });

  it('links a Google account with password re-authentication', async () => {
    const user = userEvent.setup();
    let linked = false;
    __setGoogleAuthFactory(async () => 'google-link-id-token');

    const { calls } = setup(
      { password: { set: true }, phone: { linked: false }, google: { linked: false }, googleAvailable: true },
      ({ method, path }) => {
        if (method === 'POST' && path === '/users/me/identities/google') {
          linked = true;
          return { data: { linked: true, emailMasked: 'o••••@gmail.com', replaced: false, otherSessionsEnded: 2 } };
        }
        if (method === 'GET' && path === '/users/me/identities' && linked) {
          return { data: { password: { set: true }, phone: { linked: false }, google: { linked: true, emailMasked: 'o••••@gmail.com' }, googleAvailable: true } };
        }
        return undefined;
      }
    );

    renderShop('/shop/settings');
    await user.click(await screen.findByRole('button', { name: 'Link Google account' }));
    const panel = screen.getByTestId('google-link-panel');
    expect(within(panel).getByRole('button', { name: 'Continue with Google' })).toBeDisabled();

    await user.type(within(panel).getByLabelText('Current password'), 'secret-password');
    expect(within(panel).getByRole('button', { name: 'Continue with Google' })).toBeEnabled();

    await user.click(within(panel).getByRole('button', { name: 'Continue with Google' }));

    expect(await screen.findByText(/Google account linked: o••••@gmail\.com\. You were signed out on 2 other devices\./)).toBeInTheDocument();
    const postCall = calls.find((c) => c.method === 'POST' && c.path === '/users/me/identities/google');
    expect(postCall?.body).toEqual({
      firebaseIdToken: 'google-link-id-token',
      reauth: { currentPassword: 'secret-password' }
    });
    expect(await screen.findByTestId('google-linked-email')).toHaveTextContent('o••••@gmail.com');
  });

  it('shows error when current password is wrong during linking', async () => {
    const user = userEvent.setup();
    __setGoogleAuthFactory(async () => 'google-link-id-token');

    setup(
      { password: { set: true }, phone: { linked: false }, google: { linked: false }, googleAvailable: true },
      ({ method, path }) => {
        if (method === 'POST' && path === '/users/me/identities/google') {
          return { status: 403, error: { code: 'INVALID_CURRENT_PASSWORD' } };
        }
        return undefined;
      }
    );

    renderShop('/shop/settings');
    await user.click(await screen.findByRole('button', { name: 'Link Google account' }));
    const panel = screen.getByTestId('google-link-panel');
    await user.type(within(panel).getByLabelText('Current password'), 'wrong-password');
    await user.click(within(panel).getByRole('button', { name: 'Continue with Google' }));

    expect(await screen.findByText(/Your current password is incorrect\. Check it and try again\./)).toBeInTheDocument();
  });

  it('shows error when Google account is already linked to another shop', async () => {
    const user = userEvent.setup();
    __setGoogleAuthFactory(async () => 'google-link-id-token');

    setup(
      { password: { set: true }, phone: { linked: false }, google: { linked: false }, googleAvailable: true },
      ({ method, path }) => {
        if (method === 'POST' && path === '/users/me/identities/google') {
          return { status: 409, error: { code: 'GOOGLE_IDENTITY_UNAVAILABLE' } };
        }
        return undefined;
      }
    );

    renderShop('/shop/settings');
    await user.click(await screen.findByRole('button', { name: 'Link Google account' }));
    const panel = screen.getByTestId('google-link-panel');
    await user.type(within(panel).getByLabelText('Current password'), 'correct-password');
    await user.click(within(panel).getByRole('button', { name: 'Continue with Google' }));

    expect(await screen.findByText(/This Google account is already linked to another shop account\. Try a different Google account\./)).toBeInTheDocument();
  });

  it('shows guidance when Google popup is blocked during linking', async () => {
    const user = userEvent.setup();
    __setGoogleAuthFactory(async () => {
      throw new PhoneAuthError('popup-blocked', 'popup-blocked');
    });

    setup({ password: { set: true }, phone: { linked: false }, google: { linked: false }, googleAvailable: true });

    renderShop('/shop/settings');
    await user.click(await screen.findByRole('button', { name: 'Link Google account' }));
    const panel = screen.getByTestId('google-link-panel');
    await user.type(within(panel).getByLabelText('Current password'), 'correct-password');
    await user.click(within(panel).getByRole('button', { name: 'Continue with Google' }));

    expect(await screen.findByText(/The Google sign-in popup was blocked by your browser\. Please allow popups for this site and try again\./)).toBeInTheDocument();
  });

  it('unlinks Google account with password confirmation and preserves email/password access', async () => {
    const user = userEvent.setup();
    let unlinked = false;
    const { calls } = setup(
      { password: { set: true }, phone: { linked: false }, google: { linked: true, emailMasked: 'o••••@gmail.com' }, googleAvailable: true },
      ({ method, path }) => {
        if (method === 'POST' && path === '/users/me/identities/google/unlink') {
          unlinked = true;
          return { data: { linked: false, otherSessionsEnded: 1 } };
        }
        if (method === 'GET' && path === '/users/me/identities' && unlinked) {
          return { data: { password: { set: true }, phone: { linked: false }, google: { linked: false }, googleAvailable: true } };
        }
        return undefined;
      }
    );

    renderShop('/shop/settings');
    expect(await screen.findByTestId('google-linked-email')).toHaveTextContent('o••••@gmail.com');
    await user.click(screen.getByRole('button', { name: 'Unlink' }));

    const panel = screen.getByTestId('google-unlink-panel');
    await user.type(within(panel).getByLabelText('Current password'), 'my-password');
    await user.click(within(panel).getByRole('button', { name: 'Unlink Google account' }));

    expect(await screen.findByText(/Google account unlinked\. You can still sign in with email and password\. You were signed out on 1 other device\./)).toBeInTheDocument();
    const unlinkCall = calls.find((c) => c.method === 'POST' && c.path === '/users/me/identities/google/unlink');
    expect(unlinkCall?.body).toEqual({
      reauth: { currentPassword: 'my-password' }
    });
    expect(await screen.findByText('No Google account linked.')).toBeInTheDocument();
  });

  it('refuses to unlink if it is the only sign-in method (LAST_SIGNIN_METHOD)', async () => {
    const user = userEvent.setup();
    setup(
      { password: { set: false }, phone: { linked: false }, google: { linked: true, emailMasked: 'o••••@gmail.com' }, googleAvailable: true },
      ({ method, path }) => {
        if (method === 'POST' && path === '/users/me/identities/google/unlink') {
          return { status: 409, error: { code: 'LAST_SIGNIN_METHOD' } };
        }
        return undefined;
      }
    );

    renderShop('/shop/settings');
    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    const panel = screen.getByTestId('google-unlink-panel');
    await user.type(within(panel).getByLabelText('Current password'), 'any-password');
    await user.click(within(panel).getByRole('button', { name: 'Unlink Google account' }));

    expect(await screen.findByText(/This is your only way to sign in, so it cannot be removed\./)).toBeInTheDocument();
  });
});
