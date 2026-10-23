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
  session: { startedAt: '2026-10-16T08:00:00Z', expiresAt: '2026-10-30T08:00:00Z', otherActiveSessions: 0 }
};
const off = { available: true, enabled: false, enrolledAt: null, recoveryCodesRemaining: 0, recoveryCodesAcknowledged: false, enrollmentPending: false };
const on = { available: true, enabled: true, enrolledAt: '2026-10-17T05:00:00Z', recoveryCodesRemaining: 8, recoveryCodesAcknowledged: true, enrollmentPending: false };
const apiError = (status: number, code: string) => ({ status, error: { code, message: 'x' } });
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const enrollment = {
  issuer: 'Printout Buddy', accountName: 'root@printout.test',
  otpauthUri: `otpauth://totp/Printout%20Buddy:root%40printout.test?secret=${SECRET}&issuer=Printout%20Buddy&algorithm=SHA1&digits=6&period=30`,
  manualKey: 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP', expiresInSeconds: 900
};
const CODES = ['AAAAA-BBBBB', 'CCCCC-DDDDD', 'EEEEE-FFFFF', 'GGGGG-HHHHH', 'JJJJJ-KKKKK', 'MMMMM-NNNNN', 'PPPPP-QQQQQ', 'RRRRR-SSSSS', 'TTTTT-UUUUU', 'VVVVV-WWWWW'];

const authed: Handler = ({ method, path }) => (method === 'GET' && path === '/auth/session' ? { data: adminSession } : undefined);
const anon: Handler = ({ method, path }) => (method === 'GET' && path === '/auth/session' ? { status: 401, error: { code: 'UNAUTHORIZED' } } : undefined);
const accountGet: Handler = ({ method, path }) => (method === 'GET' && path === '/admin/account' ? { data: account } : undefined);
const status = (data: object): Handler => ({ method, path }) => (method === 'GET' && path === '/admin/account/2fa' ? { data } : undefined);
const post = (path: string, result: ReturnType<Handler>): Handler => ({ method, path: p }) => (method === 'POST' && p === path ? result : undefined);

function renderAt(path: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <Routes>
        <Route path="/admin/*" element={<AdminRoutes />} />
        <Route path="/shop/*" element={<div>SHOP AREA</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('admin sign-in with two-step verification', () => {
  const twoFactor = { twoFactorRequired: true, expiresInSeconds: 300 };

  async function reachCodeStep(extra: Handler[] = []) {
    const calls = mockFetch(anon, post('/auth/login', { data: twoFactor }), ...extra);
    const user = userEvent.setup();
    renderAt('/admin/login');
    await user.type(await screen.findByLabelText('Email'), 'root@printout.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Two-step verification' });
    return { user, ...calls };
  }

  it('asks for a code after the password, focuses the field and never keeps the password', async () => {
    await reachCodeStep();
    const field = screen.getByLabelText('Authentication code');
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('correct-horse-battery');
  });

  it('completes the sign-in with Enter, sending only the method and the code', async () => {
    const { user, calls } = await reachCodeStep([post('/auth/login/2fa', { data: adminSession }), ({ method, path }) => (method === 'GET' && path === '/admin/dashboard' ? { data: { totalShops: 0, shopsByStatus: {}, subscriptionsByStatus: {}, ordersByStatus: {}, recentShops: [], recentOrders: [] } } : undefined)]);
    await user.type(screen.getByLabelText('Authentication code'), '123 456{Enter}');
    await waitFor(() => expect(calls.find((c) => c.path === '/auth/login/2fa')).toBeTruthy());
    expect(calls.find((c) => c.path === '/auth/login/2fa')?.body).toEqual({ method: 'totp', code: '123 456' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Two-step verification' })).not.toBeInTheDocument());
  });

  it('only accepts digits in the authenticator field', async () => {
    const { user } = await reachCodeStep();
    const field = screen.getByLabelText('Authentication code');
    await user.type(field, 'ab12-3x');
    expect(field).toHaveValue('123');
  });

  it('shows a clear error for a wrong code, clears it and returns focus to the field', async () => {
    const { user } = await reachCodeStep([post('/auth/login/2fa', apiError(401, 'INVALID_TWO_FACTOR_CODE'))]);
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText(/That code is not valid/)).toBeInTheDocument();
    const field = screen.getByLabelText('Authentication code');
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveValue('');
  });

  it('does not submit an empty code', async () => {
    const { calls } = await reachCodeStep();
    expect(screen.getByRole('button', { name: 'Verify and sign in' })).toBeDisabled();
    expect(calls.filter((c) => c.path === '/auth/login/2fa')).toHaveLength(0);
  });

  it('returns to the password step when the pending sign-in expired', async () => {
    const { user } = await reachCodeStep([post('/auth/login/2fa', apiError(401, 'TWO_FACTOR_CHALLENGE_INVALID'))]);
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument();
    expect(screen.getByText('Your sign-in expired. Enter your password again.')).toBeInTheDocument();
  });

  it('announces throttling', async () => {
    const { user } = await reachCodeStep([post('/auth/login/2fa', apiError(429, 'RATE_LIMITED'))]);
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText(/Too many incorrect codes/)).toBeInTheDocument();
  });

  it('lets the admin use a recovery code and lands on Account settings with a warning', async () => {
    const { user, calls } = await reachCodeStep([
      post('/auth/login/2fa', { data: { ...adminSession, recoveryCodesRemaining: 4 } }), accountGet, status(on)
    ]);
    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    const field = screen.getByLabelText('Recovery code');
    await waitFor(() => expect(field).toHaveFocus());
    await user.type(field, 'aaaaa-bbbbb');
    expect(field).toHaveValue('AAAAA-BBBBB');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { name: 'Account settings' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login/2fa')?.body).toEqual({ method: 'recovery', code: 'AAAAA-BBBBB' });
    expect(await screen.findByText(/You signed in with a recovery code\. 4 recovery codes left/)).toBeInTheDocument();
  });

  it('Back abandons the pending sign-in on the server and returns to the password form', async () => {
    const { user, calls } = await reachCodeStep([post('/auth/login/2fa/cancel', { status: 204 })]);
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/auth/login/2fa/cancel')).toBe(true);
  });

  it('is fully keyboard operable: tab order reaches code, submit, method switch and back', async () => {
    const { user } = await reachCodeStep();
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Verify and sign in' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Use a recovery code' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toHaveFocus();
  });

  it('resumes at the code step when the shop sign-in page handed an admin over', async () => {
    mockFetch(anon);
    renderAt('/admin/login', { resumeTwoFactor: true });
    expect(await screen.findByRole('heading', { name: 'Two-step verification' })).toBeInTheDocument();
  });
});

describe('Account settings: two-step verification', () => {
  async function open(...handlers: Handler[]) {
    const calls = mockFetch(authed, accountGet, ...handlers);
    const user = userEvent.setup();
    renderAt('/admin/account');
    await screen.findByRole('heading', { name: 'Account settings' });
    return { user, ...calls };
  }

  it('explains when the server cannot offer it', async () => {
    await open(status({ ...off, available: false }));
    expect(await screen.findByText(/not available on this server yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up two-step verification' })).not.toBeInTheDocument();
  });

  it('enrolls: password, QR + manual key, verified code, recovery codes, acknowledgement', async () => {
    let enabled = false;
    const { user, calls } = await open(
      ({ method, path }) => (method === 'GET' && path === '/admin/account/2fa' ? { data: enabled ? on : off } : undefined),
      post('/admin/account/2fa/enroll', { data: enrollment }),
      ({ method, path }) => { if (method === 'POST' && path === '/admin/account/2fa/enroll/verify') { enabled = true; return { data: { enabledAt: '2026-10-17T05:00:00Z', recoveryCodes: CODES } }; } return undefined; },
      post('/admin/account/2fa/recovery-codes/acknowledge', { status: 204 })
    );
    await user.click(await screen.findByRole('button', { name: 'Set up two-step verification' }));

    // 1. re-authenticate
    const pw = within(screen.getByRole('region', { name: 'Turn on two-step verification' })).getByLabelText('Current password');
    await waitFor(() => expect(pw).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter your current password.')).toBeInTheDocument();
    await user.type(pw, 'my-current-pass{Enter}');
    expect(calls.find((c) => c.path === '/admin/account/2fa/enroll')?.body).toEqual({ currentPassword: 'my-current-pass' });

    // 2. scan + manual key
    expect(await screen.findByRole('heading', { name: 'Set up your authenticator app' })).toBeInTheDocument();
    const qr = await screen.findByRole('img', { name: /QR code for adding Printout Buddy/ });
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByLabelText('Setup key')).toHaveTextContent(enrollment.manualKey);
    expect(calls.find((c) => c.path === '/admin/account/2fa/enroll/verify')).toBeUndefined(); // nothing activated yet

    // a bad code is a field error; nothing is enabled
    await user.click(screen.getByRole('button', { name: 'Verify and turn on' }));
    expect(await screen.findByText('Enter the 6-digit code shown in your authenticator app.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Authentication code'), '654321{Enter}');
    expect(calls.find((c) => c.path === '/admin/account/2fa/enroll/verify')?.body).toEqual({ code: '654321' });

    // 3. recovery codes, then acknowledge
    expect(await screen.findByRole('heading', { name: 'Save your recovery codes now' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Save your recovery codes now' })).toHaveFocus());
    const list = screen.getByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).getByText('AAAAA-BBBBB')).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(screen.getByLabelText('I have saved these recovery codes in a safe place'));
    expect(done).toBeEnabled();
    await user.click(done);
    expect(await screen.findByText(/Two-step verification is on\. You will be asked for a code/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/admin/account/2fa/recovery-codes/acknowledge')).toBe(true);
    // The secret and the codes are gone from the page once the flow is finished.
    expect(document.body.textContent).not.toContain('AAAAA-BBBBB');
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('keeps the field error on a rejected code and focuses it', async () => {
    const { user } = await open(status(off), post('/admin/account/2fa/enroll', { data: enrollment }), post('/admin/account/2fa/enroll/verify', apiError(403, 'INVALID_TWO_FACTOR_CODE')));
    await user.click(await screen.findByRole('button', { name: 'Set up two-step verification' }));
    await user.type(within(screen.getByRole('region', { name: 'Turn on two-step verification' })).getByLabelText('Current password'), 'pw-pw-pw-pw{Enter}');
    await user.type(await screen.findByLabelText('Authentication code'), '111111{Enter}');
    expect(await screen.findByText(/That code is not valid/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Authentication code')).toHaveFocus());
    expect(screen.queryByRole('heading', { name: 'Save your recovery codes now' })).not.toBeInTheDocument();
  });

  it('maps a wrong password to the field', async () => {
    const { user } = await open(status(off), post('/admin/account/2fa/enroll', apiError(403, 'INVALID_CURRENT_PASSWORD')));
    await user.click(await screen.findByRole('button', { name: 'Set up two-step verification' }));
    const f = () => within(screen.getByRole('region', { name: 'Turn on two-step verification' }));
    await user.type(f().getByLabelText('Current password'), 'nope-nope{Enter}');
    expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument();
    await waitFor(() => expect(f().getByLabelText('Current password')).toHaveFocus());
  });

  it('shows the enabled state with enrollment date and remaining recovery codes', async () => {
    await open(status(on));
    const card = await screen.findByRole('region', { name: 'Two-step verification' });
    expect(within(card).getByText('On')).toBeInTheDocument();
    expect(within(card).getByText('8')).toBeInTheDocument();
    expect(within(card).getByText(/17 Oct 2026/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Get new recovery codes' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
  });

  it('warns when recovery codes are running low or were never acknowledged', async () => {
    await open(status({ ...on, recoveryCodesRemaining: 2 }));
    expect(await screen.findByText(/You have few recovery codes left/)).toBeInTheDocument();
    cleanup();
    await open(status({ ...on, recoveryCodesAcknowledged: false }));
    expect(await screen.findByText(/have not confirmed that you saved your recovery codes/)).toBeInTheDocument();
  });

  it('regenerates recovery codes after password + authenticator code and shows the new set once', async () => {
    const { user, calls } = await open(status(on), post('/admin/account/2fa/recovery-codes', { data: { recoveryCodes: CODES } }), post('/admin/account/2fa/recovery-codes/acknowledge', { status: 204 }));
    await user.click(await screen.findByRole('button', { name: 'Get new recovery codes' }));
    await user.type(within(screen.getByRole('region', { name: 'Get new recovery codes' })).getByLabelText('Current password'), 'my-current-pass');
    await user.type(screen.getByLabelText('Authentication code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Generate new codes' }));
    expect(await screen.findByText(/Your previous codes no longer work/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/admin/account/2fa/recovery-codes')?.body).toEqual({ currentPassword: 'my-current-pass', code: '246810' });
    expect(calls.find((c) => c.path === '/admin/account/2fa/recovery-codes')?.headers['x-csrf-token']).toBe('csrf-a');
  });

  it('disables two-step verification with a recovery code after confirmation, and reports it', async () => {
    let enabled = true;
    const { user, calls } = await open(
      ({ method, path }) => (method === 'GET' && path === '/admin/account/2fa' ? { data: enabled ? on : off } : undefined),
      ({ method, path }) => { if (method === 'POST' && path === '/admin/account/2fa/disable') { enabled = false; return { data: { enabled: false } }; } return undefined; }
    );
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    await user.type(within(screen.getByRole('region', { name: 'Turn off two-step verification' })).getByLabelText('Current password'), 'my-current-pass');
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(screen.getByLabelText('Recovery code'), 'aaaaa-bbbbb');
    await user.click(screen.getByRole('button', { name: 'Turn off two-step verification' }));
    expect(await screen.findByText('Two-step verification is off.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/admin/account/2fa/disable')?.body).toEqual({ currentPassword: 'my-current-pass', method: 'recovery', code: 'AAAAA-BBBBB' });
    expect(await screen.findByRole('button', { name: 'Set up two-step verification' })).toBeInTheDocument();
  });

  it('can be cancelled without any request', async () => {
    const { user, calls } = await open(status(on));
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Turn off' })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
