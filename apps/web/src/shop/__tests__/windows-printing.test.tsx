import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, emptyList, mockFetch, order, renderShop, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';
import type { DeviceView, PrinterView, PrintJobView } from '../../lib/shop-api';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); window.sessionStorage.clear(); });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const printer = (o: Partial<PrinterView> = {}): PrinterView => ({
  id: 'pr1', deviceId: 'd1', name: 'Front Desk LaserJet', driverName: 'PCL6', connectivity: 'ONLINE', statusDetail: null, supportsColour: false,
  supportsDuplex: true, paperSizes: ['A4'], present: true, authorized: false, isDefault: false, lastReportedAt: ago(1000), ...o
});
const device = (printers: PrinterView[]): DeviceView => ({
  id: 'd1', name: 'Counter PC', platform: 'WINDOWS', status: 'ACTIVE', presence: 'ONLINE', lastSeenAt: ago(5000), createdAt: ago(86_400_000), revokedAt: null, appVersion: '0.1.0', printers
});
const job = (o: Partial<PrintJobView> = {}): PrintJobView => ({
  id: 'j1', orderId: 'o1', deviceId: 'd1', printerId: 'pr1', printerName: 'Front Desk LaserJet', status: 'QUEUED', attempt: 1, spoolerJobId: null, spoolerState: null,
  errorCode: null, errorMessage: null, duplicateRisk: false, needsReconciliation: false, resolution: null, printInitiatedAt: null, createdAt: ago(60_000), updatedAt: ago(1000), ...o
});
const devices = (list: DeviceView[]): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/devices' ? { data: { devices: list } } : undefined);
const jobs = (list: PrintJobView[]): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/print-jobs' ? { data: { jobs: list } } : undefined);

describe('Devices page: Windows printers', () => {
  it('lists printers with status and capabilities; authorizing and choosing the default are owner actions', async () => {
    let list = [printer(), printer({ id: 'pr2', name: 'Back Office Inkjet', supportsColour: true, supportsDuplex: false, connectivity: 'OFFLINE', statusDetail: 'Offline' })];
    const { calls } = mockFetch(authedSession, emptyList, ({ method, path, body }) => {
      if (method === 'PATCH' && path === '/shop/devices/d1/printers/pr1') {
        list = list.map((p) => (p.id === 'pr1' ? { ...p, ...body } : p));
        return { data: { printer: list[0] } };
      }
      return undefined;
    }, ({ method, path }) => (method === 'GET' && path === '/shop/devices' ? { data: { devices: [device(list)] } } : undefined));
    renderShop('/shop/devices');
    const items = await screen.findAllByTestId('printer');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Front Desk LaserJet')).toBeInTheDocument();
    expect(within(items[0]!).getByText(/Black & white · Two-sided · A4/)).toBeInTheDocument();
    expect(within(items[1]!).getByText('Offline', { selector: '.pb-chip' })).toBeInTheDocument();
    expect(within(items[1]!).getByText(/Colour · One-sided/)).toBeInTheDocument();
    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Authorize Front Desk LaserJet' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ authorized: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Make Front Desk LaserJet the default' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ isDefault: true }));
    expect(screen.getAllByText(/does not confirm paper came out/).length).toBeGreaterThan(0);
  });

  it('a Windows computer with no reported printers says so; Android devices show no printer section', async () => {
    mockFetch(authedSession, emptyList, devices([device([]), { ...device([]), id: 'd2', name: 'Phone', platform: 'ANDROID' }]));
    renderShop('/shop/devices');
    expect(await screen.findByText(/No printers reported yet/)).toBeInTheDocument();
    expect(screen.getAllByTestId('printer-list')).toHaveLength(1);
  });
});

describe('Order detail: Windows print job', () => {
  const detail = (status = 'NEW'): Handler => ({ method, path }) =>
    method === 'GET' && path === '/shop/orders/o1'
      ? { data: { order: order({ status: status as never, documentStatus: 'AVAILABLE' }), document: { status: 'AVAILABLE', deleteAfter: null, printInitiatedAt: null }, statusHistory: [] } }
      : undefined;

  it('offers "Print on Windows printer" for the authorized default printer and enqueues with an idempotency key', async () => {
    const { calls } = mockFetch(authedSession, emptyList, detail(), devices([device([printer({ authorized: true, isDefault: true })])]), jobs([]),
      ({ method, path }) => (method === 'POST' && path === '/shop/orders/o1/print-jobs' ? { status: 201, data: { job: job(), created: true } } : undefined));
    renderShop('/shop/orders/o1');
    await userEvent.click(await screen.findByRole('button', { name: 'Print on Windows printer' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/shop/orders/o1/print-jobs')).toBe(true));
    const body = calls.find((c) => c.path === '/shop/orders/o1/print-jobs')!.body;
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.printerId).toBe('pr1');
  });

  it('without a default printer it points to Devices instead of offering to print', async () => {
    mockFetch(authedSession, emptyList, detail(), devices([device([printer({ authorized: false })])]), jobs([job({ status: 'CANCELED' })]));
    renderShop('/shop/orders/o1');
    expect(await screen.findByText(/No default Windows printer is set/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Print on Windows printer' })).toBeNull();
  });

  it('PRINT_INITIATED never claims paper: wording says the queue accepted it and to check the printer', async () => {
    mockFetch(authedSession, emptyList, detail('PRINTING'), devices([device([printer({ authorized: true, isDefault: true })])]), jobs([job({ status: 'PRINT_INITIATED', spoolerState: 'Printing' })]));
    renderShop('/shop/orders/o1');
    const panel = await screen.findByTestId('print-job-panel');
    expect(within(panel).getByText('Print initiated')).toBeInTheDocument();
    expect(within(panel).getByText(/does not confirm paper came out: check the printer/)).toBeInTheDocument();
    expect(within(panel).queryByText(/printed successfully/i)).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Print again' })).toBeInTheDocument();
  });

  it('a failed job shows the reason; a retry that may duplicate pages needs confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { calls } = mockFetch(authedSession, emptyList, detail('PRINTING'), devices([device([printer({ authorized: true, isDefault: true })])]),
      jobs([job({ status: 'FAILED', errorCode: 'RENDERER_EXIT', errorMessage: 'x', duplicateRisk: true })]),
      ({ method, path }) => (method === 'POST' && path === '/shop/print-jobs/j1/retry' ? { status: 201, data: { job: job({ id: 'j2' }), created: true } } : undefined));
    renderShop('/shop/orders/o1');
    const panel = await screen.findByTestId('print-job-panel');
    expect(within(panel).getByText(/may already have reached the printer/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.path.endsWith('/retry'))).toBe(false);
    confirm.mockReturnValue(true);
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/retry'))?.body.acknowledgeDuplicateRisk).toBe(true));
  });

  it('an ambiguous job asks the shopkeeper to look at the printer and offers the three outcomes', async () => {
    const { calls } = mockFetch(authedSession, emptyList, detail('PRINTING'), devices([device([printer({ authorized: true, isDefault: true })])]),
      jobs([job({ status: 'NEEDS_RECONCILIATION', errorCode: 'LEASE_EXPIRED_AFTER_SUBMIT', needsReconciliation: true, duplicateRisk: true })]),
      ({ method, path }) => (method === 'POST' && path === '/shop/print-jobs/j1/reconcile' ? { data: { job: job({ status: 'PRINT_INITIATED' }), next: null } } : undefined));
    renderShop('/shop/orders/o1');
    const panel = await screen.findByTestId('print-job-panel');
    expect(within(panel).getByText('Needs your check')).toBeInTheDocument();
    expect(within(panel).getByText(/may or may not have printed/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Print on Windows printer' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'It did not print: print again' })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'It printed' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/reconcile'))?.body).toEqual({ resolution: 'PRINTED' }));
  });
});

describe('Queue: print job status', () => {
  it('shows the latest Windows print job state next to the order', async () => {
    const o = order({ status: 'PRINTING', printInitiatedAt: ago(60_000), deleteAfter: new Date(Date.now() + 20 * 60_000).toISOString(), documentStatus: 'PRINTED_RETENTION' as never });
    mockFetch(authedSession, ({ method, path }) => (method === 'GET' && path === '/shop/orders' ? { data: { items: [o] } } : undefined), jobs([job({ status: 'SUBMITTED_TO_SPOOLER' })]));
    renderShop('/shop');
    expect((await screen.findAllByText('In the Windows print queue')).length).toBeGreaterThan(0);
  });
});
