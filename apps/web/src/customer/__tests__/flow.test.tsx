import { screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockXHR, completeOk, deferred, initiateOk, mockApi, pdf, quoteOk, renderAt, shopOk, type Reply } from './testutils';

const base = '/public/shops/demo-shop';
const T = { timeout: 4000 };

beforeEach(() => { MockXHR.install(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

const fileInput = () => screen.getByTestId('file-input') as HTMLInputElement;

async function startUpload(user: ReturnType<typeof userEvent.setup>, file = pdf()) {
  await user.upload(fileInput(), file);
}
async function finishUpload() {
  await waitFor(() => expect(MockXHR.instances.length).toBeGreaterThan(0));
  act(() => MockXHR.last.respond(200));
}

describe('shop landing', () => {
  it.each([[1, '1 minute'], [45, '45 minutes']])('privacy copy follows the server retentionMinutes=%s', async (n, phrase) => {
    mockApi({ [`GET ${base}`]: { data: { ...shopOk, retentionMinutes: n } } });
    renderAt('/p/demo-shop');
    expect(await screen.findByText(`Deleted ${phrase} after printing.`)).toBeInTheDocument();
  });

  it('privacy copy falls back to 30 minutes when the server omits retentionMinutes', async () => {
    const { retentionMinutes: _omit, ...legacy } = shopOk;
    mockApi({ [`GET ${base}`]: { data: legacy } });
    renderAt('/p/demo-shop');
    expect(await screen.findByText('Deleted 30 minutes after printing.')).toBeInTheDocument();
  });

  it('shows shop details, privacy line and the choose-file CTA', async () => {
    mockApi({ [`GET ${base.replace('/public/shops/demo-shop', '/public/shops/demo-shop')}`]: { data: shopOk } });
    renderAt('/p/demo-shop');
    expect(await screen.findByRole('heading', { name: 'Demo Copy Centre' })).toBeInTheDocument();
    expect(screen.getByText('12 Main Road')).toBeInTheDocument();
    expect(screen.getByText('Deleted 30 minutes after printing.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose file' })).toBeInTheDocument();
    expect(screen.getByText(/PDF, JPG or PNG, up to 50\.0 MB/)).toBeInTheDocument();
  });

  it('shows a friendly not-found for an unknown shop', async () => {
    mockApi({ [`GET ${base}`]: { status: 404, error: { code: 'NOT_FOUND' } } });
    renderAt('/p/demo-shop');
    expect(await screen.findByRole('heading', { name: 'Shop not found' })).toBeInTheDocument();
  });

  it('shows not-accepting-orders when the shop is closed', async () => {
    mockApi({ [`GET ${base}`]: { data: { ...shopOk, acceptsOrders: false } } });
    renderAt('/p/demo-shop');
    expect(await screen.findByRole('heading', { name: 'Not accepting orders' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose file' })).not.toBeInTheDocument();
  });

  it('lists recent orders from this device', async () => {
    localStorage.setItem('printout.recentOrders.v1', JSON.stringify([{ token: 'tok'.repeat(12), orderNumber: 'DEMO-1', shopName: 'Demo', at: 1 }]));
    mockApi({ [`GET ${base}`]: { data: shopOk } });
    renderAt('/p/demo-shop');
    expect(await screen.findByRole('link', { name: /DEMO-1/ })).toHaveAttribute('href', `/t/${'tok'.repeat(12)}`);
  });
});

describe('upload', () => {
  const api = (over: Record<string, any> = {}) => mockApi({
    [`GET ${base}`]: { data: shopOk },
    [`POST ${base}/uploads/initiate`]: { data: initiateOk },
    [`POST ${base}/uploads/up-12345678/complete`]: { data: completeOk },
    [`POST ${base}/quotes`]: { data: quoteOk },
    ...over
  });

  it('uploads with real progress, verifies, then shows the server page count', async () => {
    const gate = deferred<Reply>();
    const m = api({ [`POST ${base}/uploads/up-12345678/complete`]: () => gate.promise });
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    await startUpload(user, pdf('report.pdf', 4096));
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    const x = MockXHR.last;
    expect(x.method).toBe('PUT');
    expect(x.url).toBe(initiateOk.uploadUrl);
    expect(x.headers['content-type']).toBe('application/pdf');
    expect(m.calls.find((c) => c.path.endsWith('/initiate'))?.body).toEqual({ fileName: 'report.pdf', byteSize: 4096, declaredMimeType: 'application/pdf' });
    act(() => x.progress(50, 100));
    expect(await screen.findByText('Uploading 50%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    act(() => x.respond(200));
    expect(await screen.findByText('Checking your file…')).toBeInTheDocument();
    gate.resolve({ data: completeOk });
    expect(await screen.findByText(/pages · ready/)).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('cancel aborts the upload and returns to idle', async () => {
    api();
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    await startUpload(user);
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(MockXHR.last.aborted).toBe(true);
    expect(await screen.findByRole('button', { name: 'Choose file' })).toBeInTheDocument();
  });

  it.each([
    ['exe', 'malware.exe', 'application/x-msdownload', 100, /not supported/],
    ['empty', 'empty.pdf', 'application/pdf', 0, /empty/],
    ['big', 'big.pdf', 'application/pdf', 60 * 1048576, /too large/]
  ])('rejects %s files client-side without any API call', async (_n, name, type, size, msg) => {
    const m = api();
    const user = userEvent.setup({ applyAccept: false });
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    const f = new File(['x'], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    await user.upload(fileInput(), f);
    expect(await screen.findByRole('alert')).toHaveTextContent(msg);
    expect(m.count('POST', `${base}/uploads/initiate`)).toBe(0);
  });

  it.each([
    ['PDF_TOO_MANY_PAGES', /too many pages/],
    ['INVALID_PDF', /could not read/],
    ['PASSWORD_PROTECTED_PDF', /password protected/],
    ['INVALID_FILE_TYPE', /not supported/],
    ['FILE_TOO_LARGE', /too large/],
    ['EMPTY_FILE', /empty/]
  ])('maps server rejection %s from complete to a human message', async (code, msg) => {
    api({ [`POST ${base}/uploads/up-12345678/complete`]: { status: 422, error: { code } } });
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    await startUpload(user);
    await finishUpload();
    expect(await screen.findByRole('alert')).toHaveTextContent(msg);
  });

  it('maps RATE_LIMITED and SHOP_UNAVAILABLE on initiate', async () => {
    api({ [`POST ${base}/uploads/initiate`]: { status: 429, error: { code: 'RATE_LIMITED' } } });
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    await startUpload(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('treats a 404 on initiate as shop unavailable (no retry button)', async () => {
    api({ [`POST ${base}/uploads/initiate`]: { status: 404, error: { code: 'NOT_FOUND' } } });
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    await startUpload(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(/not accepting orders/);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows a network error for a failed PUT and retries from scratch', async () => {
    const m = api();
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    await startUpload(user);
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    act(() => MockXHR.last.fail());
    expect(await screen.findByRole('alert')).toHaveTextContent(/Cannot reach the server/);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(MockXHR.instances.length).toBe(2));
    expect(m.count('POST', `${base}/uploads/initiate`)).toBe(2);
    act(() => MockXHR.last.respond(200));
    expect(await screen.findByText(/pages · ready/)).toBeInTheDocument();
  });

  it('parses an error body from the PUT response', async () => {
    api();
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    await startUpload(user);
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    act(() => MockXHR.last.respond(413, { error: { code: 'FILE_TOO_LARGE', message: 'x' } }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/too large/);
  });

  it('keeps long file names inside a truncating element', async () => {
    api();
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    const long = 'a'.repeat(200) + '.pdf';
    await startUpload(user, pdf(long));
    const el = await screen.findByTitle(long);
    expect(el).toHaveClass('cx-file-name');
  });

  it('replace file returns to the picker', async () => {
    api();
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    await startUpload(user);
    await finishUpload();
    await user.click(await screen.findByRole('button', { name: 'Replace file' }));
    expect(await screen.findByRole('button', { name: 'Choose file' })).toBeInTheDocument();
  });
});

describe('configure and quote', () => {
  const setup = async (quoteHandler: any = { data: quoteOk }, extra: Record<string, any> = {}) => {
    const m = mockApi({
      [`GET ${base}`]: { data: shopOk },
      [`POST ${base}/uploads/initiate`]: { data: initiateOk },
      [`POST ${base}/uploads/up-12345678/complete`]: { data: completeOk },
      [`POST ${base}/quotes`]: quoteHandler,
      ...extra
    });
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    await startUpload(user);
    await finishUpload();
    await screen.findByText(/pages · ready/);
    return { m, user };
  };

  it('shows the server quote with breakdown and never computes a price itself', async () => {
    const { m } = await setup({ data: { ...quoteOk, totalPaise: 12345 } });
    expect(await screen.findByTestId('total', {}, T)).toHaveTextContent('₹123.45');
    expect(screen.getByText('Pages selected')).toBeInTheDocument();
    expect(screen.getByText('Price per sheet').nextSibling).toHaveTextContent('₹2.00');
    const q = m.calls.find((c) => c.path.endsWith('/quotes'))!;
    expect(q.body).toEqual({ documentId: 'doc-12345678', printOptions: { paperSize: 'A4', colourMode: 'bw', sides: 'single', copies: 1, pageSelection: { mode: 'all' } } });
  });

  it('sends custom ranges and displays INVALID_PAGE_RANGE from the server', async () => {
    const { m, user } = await setup((c: any) => (c.body.printOptions.pageSelection.mode === 'ranges'
      ? { status: 422, error: { code: 'INVALID_PAGE_RANGE' } } : { data: quoteOk }));
    await screen.findByTestId('total', {}, T);
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    await user.type(screen.getByLabelText(/Pages to print/), '1-5,8,10-12');
    await waitFor(() => expect(m.calls.some((c) => c.body?.printOptions?.pageSelection?.mode === 'ranges')).toBe(true), T);
    const call = m.calls.find((c) => c.body?.printOptions?.pageSelection?.mode === 'ranges')!;
    expect(call.body.printOptions.pageSelection.ranges).toEqual([{ from: 1, to: 5 }, { from: 8, to: 8 }, { from: 10, to: 12 }]);
    expect((await screen.findAllByText(/not valid for this document/, {}, T)).length).toBeGreaterThan(0);
  });

  it('gives instant client validation for bad ranges and sends no quote', async () => {
    const { m, user } = await setup();
    await screen.findByTestId('total', {}, T);
    const before = m.count('POST', `${base}/quotes`);
    await user.click(screen.getByRole('radio', { name: 'Custom' }));
    const field = screen.getByLabelText(/Pages to print/);
    await user.type(field, '5-1');
    expect(await screen.findByText(/backwards/)).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '1-99');
    expect(await screen.findByText(/has 12 pages/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 600));
    expect(m.count('POST', `${base}/quotes`)).toBe(before);
    expect(screen.getByRole('button', { name: 'Place order' })).toBeDisabled();
  });

  it('validates copies', async () => {
    const { user } = await setup();
    const copies = screen.getByLabelText('Copies');
    await user.clear(copies);
    await user.type(copies, '1001');
    expect(await screen.findByText(/between 1 and 1000/)).toBeInTheDocument();
    await user.clear(copies);
    await user.type(copies, '7');
    await user.click(screen.getByRole('button', { name: 'Increase copies' }));
    expect(copies).toHaveValue('8');
  });

  it('shows a friendly message for NO_PRICING_RULE', async () => {
    await setup({ status: 422, error: { code: 'NO_PRICING_RULE' } });
    expect(await screen.findByText(/hasn't set a price for that option/, {}, T)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place order' })).toBeDisabled();
  });

  it('ignores stale quote responses (race)', async () => {
    const slow = deferred<Reply>();
    const fast = deferred<Reply>();
    let n = 0;
    const { user } = await setup(() => (++n === 1 ? slow.promise : fast.promise));
    // First quote (all/single/bw) is in flight. Change to colour -> second quote.
    await waitFor(() => expect(n).toBe(1), T);
    await user.click(screen.getByRole('radio', { name: 'Colour' }));
    await waitFor(() => expect(n).toBe(2), T);
    fast.resolve({ data: { ...quoteOk, quoteId: 'q-fast', totalPaise: 5000 } });
    expect(await screen.findByTestId('total')).toHaveTextContent('₹50.00');
    slow.resolve({ data: { ...quoteOk, quoteId: 'q-slow', totalPaise: 100 } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('total')).toHaveTextContent('₹50.00');
  });
});

describe('submit', () => {
  const setup = async (orderHandler: any) => {
    const m = mockApi({
      [`GET ${base}`]: { data: shopOk },
      [`POST ${base}/uploads/initiate`]: { data: initiateOk },
      [`POST ${base}/uploads/up-12345678/complete`]: { data: completeOk },
      [`POST ${base}/quotes`]: { data: quoteOk },
      [`POST ${base}/orders`]: orderHandler,
      [`GET /public/orders/*`]: { data: { orderNumber: 'DEMO-1', shopName: 'Demo Copy Centre', status: 'NEW', totalPaise: 2400, currency: 'INR' } }
    });
    const user = userEvent.setup();
    renderAt('/p/demo-shop');
    await screen.findByRole('button', { name: 'Choose file' });
    await startUpload(user);
    await finishUpload();
    await screen.findByTestId('total', {}, T);
    return { m, user };
  };
  const order = { data: { orderNumber: 'DEMO-1', trackingToken: 't'.repeat(40), status: 'NEW', totalPaise: 2400, currency: 'INR' } };

  it('prevents duplicate submits and navigates to tracking with replace; remembers the token', async () => {
    const gate = deferred<Reply>();
    const { m, user } = await setup(() => gate.promise);
    await user.type(screen.getByLabelText(/Name or reference/), '  Asha  ');
    const btn = screen.getByRole('button', { name: 'Place order' });
    await user.dblClick(btn);
    expect(screen.getByRole('button', { name: 'Placing order…' })).toBeDisabled();
    expect(m.count('POST', `${base}/orders`)).toBe(1);
    gate.resolve(order);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/t/${'t'.repeat(40)}`));
    const body = m.calls.find((c) => c.path.endsWith('/orders'))!.body;
    expect(body).toMatchObject({ quoteId: 'q1', customerDisplayNameOrReference: 'Asha' });
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByRole('heading', { name: /Order DEMO-1/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('printout.recentOrders.v1')!)[0]).toMatchObject({ orderNumber: 'DEMO-1' });
  });

  it('keeps state on network failure and retries with the SAME clientRequestId', async () => {
    let n = 0;
    const { m, user } = await setup(() => (++n === 1 ? 'network' as const : order));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Cannot reach the server/);
    expect(screen.getByTestId('total')).toHaveTextContent('₹24.00');
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/t/'));
    const ids = m.calls.filter((c) => c.path.endsWith('/orders')).map((c) => c.body.clientRequestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('shows pay-the-shop and privacy copy', async () => {
    await setup(order);
    expect(screen.getByText(/Pay the shop directly when you collect/)).toBeInTheDocument();
    expect(screen.getByText(/deleted 30 minutes after printing/)).toBeInTheDocument();
    const card = screen.getByRole('region', { name: /Review/ });
    expect(within(card).getByRole('button', { name: 'Place order' })).toBeEnabled();
  });
});
