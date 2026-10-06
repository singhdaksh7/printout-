import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, emptyList, mockFetch, renderShop, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';
import type { DeviceView } from '../../lib/shop-api';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); window.sessionStorage.clear(); });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const dev = (o: Partial<DeviceView> = {}): DeviceView => ({
  id: 'd1', name: 'Counter PC', platform: 'WINDOWS', status: 'ACTIVE', presence: 'ONLINE', lastSeenAt: ago(30_000),
  createdAt: ago(5 * 86_400_000), revokedAt: null, appVersion: '1.2.0', ...o
});
const list = (devices: DeviceView[]): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/devices' ? { data: { devices } } : undefined);
const setup = (devices: DeviceView[], ...extra: Handler[]) => mockFetch(authedSession, emptyList, ...extra, list(devices));

describe('printing devices list', () => {
  it('renders online, offline and revoked devices with platform badges and last-seen copy', async () => {
    setup([
      dev(),
      dev({ id: 'd2', name: 'Asha phone', platform: 'ANDROID', presence: 'OFFLINE', lastSeenAt: ago(2 * 3600_000), appVersion: null }),
      dev({ id: 'd3', name: 'Old tablet', platform: 'ANDROID', status: 'REVOKED', presence: 'REVOKED', revokedAt: ago(86_400_000) })
    ]);
    renderShop('/shop/devices');
    const cards = await screen.findAllByTestId('device-card');
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText('Counter PC')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Windows')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Online')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Last seen just now')).toHaveAttribute('title');
    expect(within(cards[1]!).getByText('Android')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Offline')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Last seen 2 h ago')).toBeInTheDocument();
    expect(within(cards[2]!).getByText('Revoked')).toBeInTheDocument();
    expect(within(cards[2]!).queryByRole('button')).toBeNull();
    expect(screen.getByText(/not a live connection/)).toBeInTheDocument();
  });

  it('shows "Not seen yet" for a device that never checked in', async () => {
    setup([dev({ presence: 'OFFLINE', lastSeenAt: null })]);
    renderShop('/shop/devices');
    expect(await screen.findByText('Not seen yet')).toBeInTheDocument();
  });

  it('shows a loading skeleton, then the empty state', async () => {
    setup([]);
    renderShop('/shop/devices');
    expect(await screen.findByRole('status', { name: 'Loading devices' })).toBeInTheDocument();
    const empty = await screen.findByTestId('devices-empty');
    expect(empty).toHaveTextContent('Browser printing keeps working; add a device later to print from your phone or PC');
  });

  it('shows an error banner and recovers on Retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    mockFetch(authedSession, emptyList, ({ method, path }) => {
      if (method === 'GET' && path === '/shop/devices') return fail ? { status: 500, error: { code: 'INTERNAL' } } : { data: { devices: [dev()] } };
      return undefined;
    });
    renderShop('/shop/devices');
    expect(await screen.findByText(/server had a problem/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Counter PC')).toBeInTheDocument();
    expect(screen.queryByText(/server had a problem/)).toBeNull();
  });

  it('never renders secret-like fields even if the API sent them', async () => {
    setup([{ ...dev(), credentialHash: 'abc', pushToken: 'fcm-xyz', credential: 'pbd_secret' } as unknown as DeviceView]);
    const { container } = renderShop('/shop/devices');
    await screen.findByTestId('device-card');
    const text = (container.textContent ?? '').toLowerCase();
    for (const bad of ['credential', 'pbd_', 'token', 'fcm-xyz', 'hash']) expect(text).not.toContain(bad);
  });

  it('uses single-column wrapping card layout classes (mobile first, no table)', async () => {
    setup([dev({ name: 'A'.repeat(60) })]);
    const { container } = renderShop('/shop/devices');
    await screen.findByTestId('device-card');
    expect(container.querySelector('ul.dev-list')).not.toBeNull();
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('.dev-name.sh-wrap')).not.toBeNull();
  });
});

describe('rename', () => {
  it('renames successfully and updates the card', async () => {
    const user = userEvent.setup();
    const { calls } = setup([dev()], ({ method, path, body }) => (method === 'PATCH' && path === '/shop/devices/d1' ? { data: { device: dev({ name: body.name }) } } : undefined));
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Rename Counter PC' }));
    const input = screen.getByLabelText('Device name');
    await waitFor(() => expect(input).toHaveFocus());
    await user.clear(input);
    await user.type(input, '  Front desk  ');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Front desk')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Front desk' });
    expect(screen.getByText('Device renamed')).toBeInTheDocument();
  });

  it('validates 1-60 chars without calling the API', async () => {
    const user = userEvent.setup();
    const { calls } = setup([dev()]);
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Rename Counter PC' }));
    const input = screen.getByLabelText('Device name');
    expect(input).toHaveAttribute('maxlength', '60');
    await user.clear(input);
    await user.type(input, '   ');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('between 1 and 60');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('shows a server error and keeps the dialog open', async () => {
    const user = userEvent.setup();
    setup([dev()], ({ method }) => (method === 'PATCH' ? { status: 400, error: { code: 'VALIDATION_ERROR' } } : undefined));
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Rename Counter PC' }));
    await user.type(screen.getByLabelText('Device name'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText(/Some values are not valid/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Counter PC')).toBeInTheDocument();
  });
});

describe('revoke', () => {
  const revokeApi: Handler = ({ method, path }) => (method === 'POST' && path === '/shop/devices/d1/revoke'
    ? { data: { device: dev({ status: 'REVOKED', presence: 'REVOKED', revokedAt: new Date().toISOString() }) } } : undefined);

  it('explains consequences, and Cancel makes no request', async () => {
    const user = userEvent.setup();
    const { calls } = setup([dev()], revokeApi);
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Disconnect Counter PC' }));
    const dlg = screen.getByRole('dialog', { name: 'Disconnect this device?' });
    expect(dlg).toHaveTextContent('stop working immediately');
    expect(dlg).toHaveTextContent('no longer be able to see your orders or print');
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/revoke'))).toBe(false);
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('confirming marks the device Revoked and removes its actions', async () => {
    const user = userEvent.setup();
    setup([dev()], revokeApi);
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Disconnect Counter PC' }));
    await user.click(screen.getByRole('button', { name: 'Disconnect device' }));
    const card = await screen.findByTestId('device-card');
    await waitFor(() => expect(within(card).getByText('Revoked')).toBeInTheDocument());
    expect(within(card).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows an error when revoke fails', async () => {
    const user = userEvent.setup();
    setup([dev()], ({ method, path }) => (method === 'POST' && path.endsWith('/revoke') ? { status: 500, error: { code: 'INTERNAL' } } : undefined));
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Disconnect Counter PC' }));
    await user.click(screen.getByRole('button', { name: 'Disconnect device' }));
    expect(await screen.findByText(/server had a problem/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('add device (pairing code)', () => {
  const codeApi = (expiresInMs: number, codes: string[] = ['PB-ABCD-2345']): { handler: Handler; count: () => number } => {
    let n = 0;
    return {
      handler: ({ method, path, body }) => {
        if (method === 'POST' && path === '/shop/devices/pairing-codes') {
          expect(body).toEqual({});
          return { data: { code: codes[Math.min(n++, codes.length - 1)], expiresAt: new Date(Date.now() + expiresInMs).toISOString() } };
        }
        return undefined;
      },
      count: () => n
    };
  };

  it('requests a code, shows it large with countdown, instructions and one-time note', async () => {
    const user = userEvent.setup();
    const api = codeApi(9 * 60_000 + 41_000);
    setup([dev()], api.handler);
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Add device' }));
    expect(await screen.findByTestId('pairing-code')).toHaveTextContent('PB-ABCD-2345');
    expect(screen.getByRole('timer')).toHaveTextContent(/Expires in 9:4\d/);
    expect(screen.getByText(/Open PrintoutBuddy on your phone or PC/)).toBeInTheDocument();
    expect(screen.getByText(/Add shop and enter this code/)).toBeInTheDocument();
    expect(screen.getByText(/code works once/)).toBeInTheDocument();
    expect(api.count()).toBe(1);
  });

  it('copies the code and announces it politely; no storage writes', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setup([dev()], codeApi(600_000).handler);
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Add device' }));
    await screen.findByTestId('pairing-code');
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('PB-ABCD-2345');
    const live = (await screen.findAllByText('Code copied')).find((e) => e.getAttribute('aria-live') === 'polite');
    expect(live).toBeDefined();
    for (const [, v] of setItem.mock.calls.map((c) => c)) expect(String(v)).not.toContain('PB-');
    expect(JSON.stringify(window.localStorage) + JSON.stringify(window.sessionStorage)).not.toContain('PB-ABCD');
    setItem.mockRestore();
  });

  it('expires, drops the code, and generates a new one', async () => {
    const user = userEvent.setup();
    const api = codeApi(1500, ['PB-AAAA-1111', 'PB-BBBB-2222']);
    setup([dev()], api.handler);
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Add device' }));
    await screen.findByText('PB-AAAA-1111');
    expect(await screen.findByText(/This code has expired/, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText('PB-AAAA-1111')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Generate new code' }));
    expect(await screen.findByText('PB-BBBB-2222')).toBeInTheDocument();
    expect(api.count()).toBe(2);
  });

  it('shows a server error with a way to retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    setup([dev()], ({ method, path }) => (method === 'POST' && path === '/shop/devices/pairing-codes'
      ? (fail ? { status: 429, error: { code: 'RATE_LIMITED' } } : { data: { code: 'PB-CCCC-3333', expiresAt: new Date(Date.now() + 600_000).toISOString() } })
      : undefined));
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Add device' }));
    expect(await screen.findByText(/Too many requests/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Generate new code' }));
    expect(await screen.findByText('PB-CCCC-3333')).toBeInTheDocument();
  });

  it('closing clears the code and refreshes the list; reopening requests a fresh code', async () => {
    const user = userEvent.setup();
    const api = codeApi(600_000, ['PB-AAAA-1111', 'PB-BBBB-2222']);
    const { calls } = setup([dev()], api.handler);
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Add device' }));
    await screen.findByText('PB-AAAA-1111');
    const before = calls.filter((c) => c.path === '/shop/devices').length;
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('PB-AAAA-1111')).toBeNull();
    await waitFor(() => expect(calls.filter((c) => c.path === '/shop/devices').length).toBe(before + 1));
    await user.click(screen.getByRole('button', { name: 'Add device' }));
    expect(await screen.findByText('PB-BBBB-2222')).toBeInTheDocument();
  });

  it('empty state offers adding a first device', async () => {
    const user = userEvent.setup();
    setup([], codeApi(600_000).handler);
    renderShop('/shop/devices');
    await user.click(await screen.findByRole('button', { name: 'Add your first device' }));
    expect(await screen.findByTestId('pairing-code')).toBeInTheDocument();
  });
});

describe('wiring', () => {
  it('Settings links to Printing Devices and the route renders', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, list([dev()]),
      ({ path }) => (path === '/shop/settings' ? { data: { publicContact: null, brandColor: null } } : undefined));
    renderShop('/shop/settings');
    await user.click(await screen.findByRole('link', { name: /Printing Devices/ }));
    expect(await screen.findByRole('heading', { name: 'Printing Devices' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/shop/devices');
    await user.click(screen.getByRole('link', { name: /‹ Settings/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/shop/settings');
  });

  it('the shell nav is unchanged (devices live under Settings)', async () => {
    mockFetch(authedSession, emptyList, list([]));
    renderShop('/shop/devices');
    const nav = await screen.findByRole('navigation', { name: 'Shop sections' });
    expect(within(nav).getAllByRole('link')).toHaveLength(5);
  });
});
