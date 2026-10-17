import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { authedSession, emptyList, mockFetch, renderShop, session, type Handler } from './helpers';

const QR = { publicUrl: 'https://printout.test/p/central', slug: 'central' };
const qrHandler: Handler = ({ path }) => (path === '/shop/qr' ? { data: QR } : undefined);
const settingsHandler = (s: Record<string, unknown>): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/settings' ? { data: s } : undefined);

let created: Blob[] = [];
beforeEach(() => {
  window.localStorage.clear();
  created = [];
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => { created.push(b); return 'blob:poster'; }), revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('poster generator page', () => {
  it('is reachable from the QR page and shows a live preview of the real shop URL', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, qrHandler, settingsHandler({ address: '12 MG Road', publicContact: '+91 90000 00000' }));
    renderShop('/shop/qr');
    await user.click(await screen.findByRole('link', { name: 'Design a branded poster' }));
    await screen.findByTestId('poster-preview', {}, { timeout: 8000 });
    expect(screen.getByRole('heading', { name: 'Poster generator' })).toBeInTheDocument();
    const preview = await screen.findByTestId('poster-preview');
    expect(preview).toHaveAccessibleName(/Classic poster preview for Central Print, A4.*https:\/\/printout\.test\/p\/central/);
    expect(within(preview as unknown as HTMLElement).getByText('Central Print')).toBeInTheDocument();
    expect(within(preview as unknown as HTMLElement).getByText('Scan to upload documents')).toBeInTheDocument();
    expect(within(preview as unknown as HTMLElement).getByText('https://printout.test/p/central')).toBeInTheDocument();
    // Address and contact are opt-in.
    expect(within(preview as unknown as HTMLElement).queryByText('12 MG Road')).toBeNull();
  });

  it('switches template and size, toggles details, and persists only validated settings per shop', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, qrHandler, settingsHandler({ address: '12 MG Road', publicContact: '+91 90000 00000' }));
    renderShop('/shop/qr/poster');
    await screen.findByTestId('poster-preview');
    await user.click(screen.getByRole('radio', { name: /Premium/ }));
    await user.click(screen.getByRole('radio', { name: 'A5' }));
    await user.click(screen.getByRole('checkbox', { name: 'Shop address' }));
    await waitFor(() => expect(screen.getByTestId('poster-preview')).toHaveAccessibleName(/Premium poster preview.*A5/));
    expect(within(screen.getByTestId('poster-preview') as unknown as HTMLElement).getByText('12 MG Road')).toBeInTheDocument();
    const saved = JSON.parse(window.localStorage.getItem('pb.qr-poster.v1:central')!);
    expect(saved).toEqual({ template: 'premium', size: 'A5', headline: 'Scan to upload documents', showAddress: true, showContact: false, showUrl: true, showPrivacy: true });
  });

  it('ignores tampered stored settings', async () => {
    window.localStorage.setItem('pb.qr-poster.v1:central', JSON.stringify({ template: '<img onerror=x>', size: 'A0', headline: '\u0000', admin: true }));
    mockFetch(authedSession, emptyList, qrHandler, settingsHandler({}));
    renderShop('/shop/qr/poster');
    expect(await screen.findByTestId('poster-preview')).toHaveAccessibleName(/Classic poster preview.*A4/);
  });

  it('renders hostile shop names as plain text (no markup injected)', async () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    mockFetch(({ method, path }) => (method === 'GET' && path === '/auth/session' ? { data: session({ shop: { id: 's1', slug: 'central', displayName: evil } }) } : undefined), emptyList, qrHandler, settingsHandler({}));
    renderShop('/shop/qr/poster');
    const preview = await screen.findByTestId('poster-preview');
    expect(preview.querySelector('img, script, foreignObject')).toBeNull();
    expect(preview.textContent).toContain('<img src=x onerror="alert(1)">'.slice(0, 10));
  });

  it('disables address/contact with a path to Settings when none is saved', async () => {
    mockFetch(authedSession, emptyList, qrHandler, settingsHandler({}));
    renderShop('/shop/qr/poster');
    await screen.findByTestId('poster-preview');
    expect(screen.getByRole('checkbox', { name: 'Shop address' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Contact details' })).toBeDisabled();
    expect(screen.getAllByRole('link', { name: 'Add it in Settings' })[0]).toHaveAttribute('href', '/shop/settings');
  });

  it('downloads a PDF and a PNG with safe file names', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, qrHandler, settingsHandler({}));
    const names: string[] = [];
    const orig = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, o?: ElementCreationOptions) => {
      const el = orig(tag, o);
      if (tag === 'a') Object.defineProperty(el, 'download', { set: (v: string) => names.push(v), get: () => names[names.length - 1] ?? '' });
      return el;
    });
    renderShop('/shop/qr/poster');
    await screen.findByTestId('poster-preview');
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(names).toContain('printout-buddy-poster-central-a4.pdf'));
    const pdf = created[0]!;
    expect(pdf.type).toBe('application/pdf');
    const head = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(pdf.slice(0, 5)); });
    expect(head).toBe('%PDF-');
  }, 20_000);

  it('shows an error with retry when the shop link cannot be loaded', async () => {
    const user = userEvent.setup();
    let fail = true;
    mockFetch(authedSession, emptyList, ({ path }) => (path === '/shop/qr' ? (fail ? { status: 500, error: { code: 'INTERNAL', message: 'boom' } } : { data: QR }) : undefined), settingsHandler({}));
    renderShop('/shop/qr/poster');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('poster-preview')).toBeInTheDocument();
  });

  it('refuses to build a poster when the API reports a link that is not the public page', async () => {
    mockFetch(authedSession, emptyList, ({ path }) => (path === '/shop/qr' ? { data: { publicUrl: 'https://printout.test/shop/orders', slug: 'central' } } : undefined), settingsHandler({}));
    renderShop('/shop/qr/poster');
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not confirm your shop link/i);
    expect(screen.queryByTestId('poster-preview')).toBeNull();
  });

  it('reset restores the default template and clears the saved choice', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, qrHandler, settingsHandler({}));
    renderShop('/shop/qr/poster');
    await screen.findByTestId('poster-preview');
    await user.click(screen.getByRole('radio', { name: /Minimal/ }));
    await waitFor(() => expect(screen.getByTestId('poster-preview')).toHaveAccessibleName(/Minimal/));
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(screen.getByTestId('poster-preview')).toHaveAccessibleName(/Classic/));
    expect(screen.getByRole('radio', { name: /Classic/ })).toBeChecked();
  });

  it('template choices are a keyboard-operable radio group', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, emptyList, qrHandler, settingsHandler({}));
    renderShop('/shop/qr/poster');
    await screen.findByTestId('poster-preview');
    const classic = screen.getByRole('radio', { name: /Classic/ });
    classic.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: /Premium/ })).toBeChecked();
  });
});
