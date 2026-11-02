import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES, authedSession, mockFetch, order, renderShop, type Handler } from './helpers';
import { setCsrfToken } from '../../lib/api';

beforeEach(() => { FakeES.reset(); vi.stubGlobal('EventSource', FakeES); setCsrfToken(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Sections = { profile?: boolean; rates?: boolean; paper?: boolean; payments?: boolean; methods?: string[]; upiId?: string | null };
const ORDER = ['profile', 'rates', 'paper', 'payments'] as const;
function status(o: Sections) {
  const sections = {
    profile: { complete: !!o.profile, missing: o.profile ? [] : ['phoneNumber', 'city', 'state'] },
    rates: { complete: !!o.rates, activeCount: o.rates ? 2 : 0, configured: o.rates ? ['bw-single', 'bw-duplex'] : [] },
    paper: { complete: !!o.paper, optionCount: o.paper ? 2 : 0 },
    payments: { complete: !!o.payments, methods: o.methods ?? ['cash'], upiId: o.upiId ?? null }
  };
  const nextStep = ORDER.find((k) => !sections[k].complete) ?? null;
  return { shopId: 's1', shopStatus: 'ACTIVE', isOpen: true, isVerified: false, sections, nextStep, complete: nextStep === null };
}
const statusH = (o: Sections): Handler => ({ method, path }) => (method === 'GET' && path === '/shop/setup-status' ? { data: status(o) } : undefined);
const profileH: Handler = ({ method, path }) =>
  method === 'GET' && path === '/shops/s1' ? { data: { phoneNumber: null, addressLine1: 'Station Road', city: null, state: null, pincode: '110001' } } : undefined;
const ratesH: Handler = ({ method, path }) =>
  method === 'GET' && path === '/shop/pricing-rules' ? { data: [{ id: 'r1', paperSize: 'A4', colourMode: 'bw', sides: 'single', pricePerSheetPaise: 200, active: true }] } : undefined;
const orders: Handler = ({ method, path }) => (method === 'GET' && path === '/shop/orders' ? { data: { items: [order()] } } : undefined);

describe('setup stepper', () => {
  it('resumes at the first incomplete step (paper) after earlier sections are saved', async () => {
    mockFetch(authedSession, statusH({ profile: true, rates: true }), ratesH);
    renderShop('/shop/setup');
    expect(await screen.findByRole('heading', { name: 'Paper' })).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByTestId('setup-steps').querySelector('[aria-current="step"]')).toHaveTextContent('3. Paper');
  });

  it('details: validates, normalises the phone, keeps the form on a failed save and succeeds on retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { calls } = mockFetch(authedSession, statusH({}), profileH, ratesH, ({ method, path }) => {
      if (method === 'PATCH' && path === '/shops/s1') return ++attempts === 1 ? { status: 500, error: { code: 'INTERNAL', message: 'boom' } } : { data: {} };
      return undefined;
    });
    renderShop('/shop/setup');
    await screen.findByRole('heading', { name: 'Shop details' });
    await screen.findByDisplayValue('Station Road');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('Enter a 10-digit mobile number or a number starting with +.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    await user.type(screen.getByLabelText(/Shop Phone/), '98765 43210');
    await user.type(screen.getByLabelText(/^City/), 'Delhi');
    await user.type(screen.getByLabelText(/^State/), 'Delhi');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText(/server had a problem/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^City/)).toHaveValue('Delhi');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByRole('heading', { name: 'Set your printing rates' })).toBeInTheDocument();
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]!.body).toMatchObject({ phoneNumber: '+919876543210', city: 'Delhi', state: 'Delhi', pincode: '110001', addressLine1: 'Station Road' });
  });

  it('payments: UPI requires a valid UPI ID and nothing is saved until it is', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, statusH({ profile: true, rates: true, paper: true }), ratesH, ({ method, path }) =>
      method === 'PATCH' && path === '/shops/s1' ? { data: {} } : undefined);
    renderShop('/shop/setup');
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    await user.click(screen.getByLabelText('UPI'));
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('A UPI ID is required to accept UPI.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/UPI ID/), 'not-a-upi');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('Enter a valid UPI ID such as name@bank.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await user.clear(screen.getByLabelText(/UPI ID/));
    await user.type(screen.getByLabelText(/UPI ID/), 'asha@okbank');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ acceptedPaymentMethods: ['cash', 'upi'], upiId: 'asha@okbank' }));
  });

  it('paper: saves A4 + plain paper through the paper-options API', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(authedSession, statusH({ profile: true, rates: true }), ratesH, ({ method, path }) =>
      method === 'PUT' && path === '/shops/s1/paper-options' ? { data: {} } : undefined);
    renderShop('/shop/setup');
    await screen.findByRole('heading', { name: 'Paper' });
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ paperSizes: ['A4'], paperTypes: ['normal'] }));
  });

  it('paper: is blocked with a pointer to rates when no price exists', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, statusH({ profile: true }), ({ method, path }) => (method === 'GET' && path === '/shop/pricing-rules' ? { data: [] } : undefined));
    renderShop('/shop/setup');
    await user.click(await screen.findByTestId('setup-continue'));
    await screen.findByRole('heading', { name: 'Paper' });
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled();
    expect(screen.getByText('Set at least one active price before choosing paper.')).toBeInTheDocument();
  });

  it('finish: reflects the server and shows Not configured for sections that are not saved', async () => {
    const user = userEvent.setup();
    mockFetch(authedSession, statusH({ profile: true, rates: true, paper: true }), ratesH, ({ method }) => (method === 'PATCH' ? { data: {} } : undefined));
    renderShop('/shop/setup');
    await screen.findByRole('heading', { name: 'Payments' });
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    // The mocked status still reports payments unsaved: Finish must follow the server, not the form.
    expect(await screen.findByRole('heading', { name: 'Setup not finished' })).toBeInTheDocument();
    expect(screen.getAllByText('Not configured')).toHaveLength(1);
  });

  it('dashboard banner points at setup when a section after rates is incomplete', async () => {
    mockFetch(authedSession, orders, statusH({ profile: true, rates: true }), ratesH);
    renderShop('/shop');
    const banner = await screen.findByTestId('setup-incomplete');
    expect(banner).toHaveTextContent('paper options are not configured');
    expect(within(banner).getByRole('link', { name: 'Continue setup' })).toHaveAttribute('href', '/shop/setup');
  });
});
