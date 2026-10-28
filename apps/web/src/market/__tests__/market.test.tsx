import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import MarketRoutes from '../MarketRoutes';
import * as mk from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    myProfile: vi.fn(), refreshCsrf: vi.fn(async () => undefined), customerGoogleSession: vi.fn(), registerCustomer: vi.fn(), logout: vi.fn(async () => undefined),
    nearbyShops: vi.fn(), shopDetail: vi.fn(), shopReviews: vi.fn(), startUpload: vi.fn(), putFile: vi.fn(), completeUpload: vi.fn(), createQuote: vi.fn(), placeOrder: vi.fn(),
    myOrders: vi.fn(), myOrder: vi.fn(), cancelOrder: vi.fn(), submitUtr: vi.fn(), reviewOrder: vi.fn(), notifications: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn()
  };
});
vi.mock('../../lib/phone-auth', async () => {
  const actual = await vi.importActual<typeof import('../../lib/phone-auth')>('../../lib/phone-auth');
  return { ...actual, signInWithGoogleWeb: vi.fn(async () => 'google-id-token') };
});

const m = vi.mocked(mk);
const profile = { user: { id: 'u1', role: 'customer' as const, name: 'Asha', email: null }, nextStep: 'customer_home' };
const shop = (over: Partial<mk.ShopCard> = {}): mk.ShopCard => ({
  id: 'shop-1', shopName: 'Ramesh Prints', phoneNumber: null, addressLine1: '5 Market Road', city: 'Kolkata', state: 'WB', pincode: '700001', isOpen: true, acceptsOrders: true,
  availability: { state: 'open', nextOpenAt: null, closesAt: null, orderingBlocked: false }, rates: [{ paperSize: 'A4', colourMode: 'bw', sides: 'single', pricePerSheetPaise: 200 }, { paperSize: 'A4', colourMode: 'colour', sides: 'single', pricePerSheetPaise: 1000 }],
  paperSizes: ['A4'], paperTypes: ['normal'], images: [], acceptedPaymentMethods: ['cash', 'upi'], upiId: 'ramesh@okbank', ratingAvg: 4.5, ratingCount: 12, distanceKm: 1.2, ...over
});
const order = (over: Partial<mk.CustomerOrder> = {}): mk.CustomerOrder => ({
  id: 'order-1', orderNumber: 'RAMESH-0001', shopId: 'shop-1', shopName: 'Ramesh Prints', status: 'NEW', totalPaise: 1200, currency: 'INR', fileName: 'notes.pdf', pages: 3, note: null, isReviewed: false,
  payment: { method: 'cash', status: 'unpaid', upiTxnRef: null, upiId: null }, createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:00:00Z', fileDeletedAt: null,
  printOptions: { colourMode: 'bw', sides: 'single', copies: 2 }, statusHistory: [{ status: 'NEW', by: 'customer', reason: null, createdAt: '2026-10-28T10:00:00Z' }], ...over
});

// The app mounts the marketplace at /app/*; nested routes are relative to that splat.
const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/app/*" element={<MarketRoutes />} /></Routes></MemoryRouter>);
beforeEach(() => { vi.clearAllMocks(); m.myProfile.mockResolvedValue(profile); m.shopReviews.mockResolvedValue({ items: [], page: 1, limit: 10, total: 0, ratingAvg: null, ratingCount: 0 }); });
afterEach(() => cleanup());

describe('sign-in and onboarding', () => {
  it('sends a signed-out visitor to sign-in and then to the welcome step for a new customer', async () => {
    m.myProfile.mockResolvedValue(null);
    m.customerGoogleSession.mockResolvedValue({ user: { id: null, role: null, name: null, email: 'a@b.test' }, nextStep: 'create_customer' });
    renderAt('/app/orders');
    expect(await screen.findByRole('heading', { name: /print at a shop near you/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter your name.')).toBeTruthy();
    m.registerCustomer.mockResolvedValue(profile);
    m.nearbyShops.mockResolvedValue({ items: [], page: 1, limit: 20, total: 0 });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Asha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(m.registerCustomer).toHaveBeenCalledWith('Asha'));
    expect(await screen.findByRole('heading', { name: 'Shops near you' })).toBeTruthy();
  });

  it('shows a friendly message when sign-up is closed', async () => {
    m.myProfile.mockResolvedValue(null);
    m.customerGoogleSession.mockResolvedValue({ user: { id: null, role: null, name: null, email: null }, nextStep: 'create_customer' });
    m.registerCustomer.mockRejectedValue(new ApiError(403, 'CUSTOMER_SIGNUP_DISABLED', 'closed'));
    renderAt('/app/login');
    fireEvent.click(await screen.findByRole('button', { name: /continue with google/i }));
    fireEvent.change(await screen.findByLabelText(/your name/i), { target: { value: 'Asha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Customer sign-up is not open yet.')).toBeTruthy();
  });
});

describe('discovery', () => {
  it('lists nearby shops with distance, rating, price and open state', async () => {
    m.nearbyShops.mockResolvedValue({ items: [shop(), shop({ id: 'shop-2', shopName: 'Metro Copies', isOpen: false, ratingAvg: null, ratingCount: 0 })], page: 1, limit: 20, total: 2 });
    Object.defineProperty(globalThis.navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void) => ok({ coords: { latitude: 22.57, longitude: 88.36 } }) } });
    renderAt('/app');
    fireEvent.click(await screen.findByRole('button', { name: /use my location/i }));
    expect(await screen.findByText('Ramesh Prints')).toBeTruthy();
    expect(screen.getAllByText(/1\.2 km away/).length).toBe(2);
    expect(screen.getAllByText(/from ₹2\.00 per sheet/).length).toBe(2);
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('Closed')).toBeTruthy();
    expect(screen.getByText(/No ratings yet/)).toBeTruthy();
    expect(m.nearbyShops).toHaveBeenCalledWith({ lat: 22.57, lng: 88.36, radiusKm: 5 });
  });

  it('explains a blocked location permission', async () => {
    Object.defineProperty(globalThis.navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (_ok: unknown, bad: () => void) => bad() } });
    renderAt('/app');
    fireEvent.click(await screen.findByRole('button', { name: /use my location/i }));
    expect(await screen.findByText(/location is blocked/i)).toBeTruthy();
  });

  it('shows per-sheet prices and disables ordering when the shop is closed', async () => {
    m.shopDetail.mockResolvedValue(shop({ isOpen: false, availability: { state: 'closed', nextOpenAt: '2026-10-29T09:00:00Z', closesAt: null, orderingBlocked: true } }));
    renderAt('/app/shops/shop-1');
    expect(await screen.findByRole('heading', { name: 'Ramesh Prints' })).toBeTruthy();
    expect(screen.getByText(/Black and white, single-sided/)).toBeTruthy();
    expect(screen.getAllByText('₹2.00').length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: /not taking orders/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('placing an order', () => {
  async function toQuote() {
    m.shopDetail.mockResolvedValue(shop());
    m.startUpload.mockResolvedValue({ uploadId: 'up1', uploadUrl: '/u', completePath: '/c' });
    m.putFile.mockResolvedValue(undefined);
    m.completeUpload.mockResolvedValue({ documentId: 'doc1', pageCount: 3 });
    m.createQuote.mockResolvedValue({ quoteId: 'q1', shopId: 'shop-1', totalPaise: 1200, expiresAt: '2026-10-28T11:00:00Z' });
    renderAt('/app/shops/shop-1/order');
    const input = (await screen.findByLabelText(/choose a pdf/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByText(/3 pages found/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Copies'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /see price/i }));
    expect(await screen.findByText('Total ₹12.00')).toBeTruthy();
  }

  it('uploads, quotes with the chosen options, and places an order with one idempotency key across retries', async () => {
    await toQuote();
    expect(m.createQuote).toHaveBeenCalledWith('shop-1', 'doc1', { paperSize: 'A4', colourMode: 'bw', sides: 'single', copies: 2, pageSelection: { mode: 'all' } });
    fireEvent.click(screen.getByLabelText('UPI'));
    fireEvent.change(screen.getByLabelText(/note for the shop/i), { target: { value: 'Staple' } });
    m.placeOrder.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'offline'));
    fireEvent.click(screen.getByRole('button', { name: /place order/i }));
    expect(await screen.findByText(/cannot reach the server/i)).toBeTruthy();
    m.placeOrder.mockResolvedValueOnce(order());
    m.myOrder.mockResolvedValue(order());
    fireEvent.click(screen.getByRole('button', { name: /place order/i }));
    expect(await screen.findByRole('heading', { name: 'RAMESH-0001' })).toBeTruthy();
    const [first, second] = m.placeOrder.mock.calls;
    expect(first?.[1]).toBe('upi');
    expect(first?.[2]).toBe('Staple');
    expect(second?.[3]).toBe(first?.[3]);
  });

  it('rejects unsupported and oversized files before uploading', async () => {
    m.shopDetail.mockResolvedValue(shop());
    renderAt('/app/shops/shop-1/order');
    const input = (await screen.findByLabelText(/choose a pdf/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.zip', { type: 'application/zip' })] } });
    expect(await screen.findByText('Choose a PDF, JPG or PNG file.')).toBeTruthy();
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/too large/i)).toBeTruthy();
    expect(m.startUpload).not.toHaveBeenCalled();
  });

  it('refuses a copy count outside 1 to 50 and shows closed-shop errors in words', async () => {
    await toQuote();
    fireEvent.change(screen.getByLabelText('Copies'), { target: { value: '51' } });
    expect(await screen.findByText('Enter 1 to 50.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /see price/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('my orders', () => {
  it('lists orders with customer wording for each status', async () => {
    m.myOrders.mockResolvedValue({ items: [order(), order({ id: 'o2', orderNumber: 'RAMESH-0002', status: 'REJECTED' })], page: 1, limit: 20, total: 2 });
    renderAt('/app/orders');
    expect(await screen.findByText('Waiting for the shop')).toBeTruthy();
    expect(screen.getByText('Rejected by the shop')).toBeTruthy();
  });

  it('UPI order: pay instructions, reference submission, and no cancel once a reference is pending', async () => {
    const upi = order({ payment: { method: 'upi', status: 'unpaid', upiTxnRef: null, upiId: 'ramesh@okbank' } });
    m.myOrder.mockResolvedValue(upi);
    m.submitUtr.mockImplementation(async () => { m.myOrder.mockResolvedValue(order({ payment: { method: 'upi', status: 'pendingVerification', upiTxnRef: 'UTR123456789', upiId: 'ramesh@okbank' } })); return upi; });
    renderAt('/app/orders/order-1');
    expect(await screen.findByText('ramesh@okbank')).toBeTruthy();
    expect(screen.getByRole('button', { name: /cancel order/i })).toBeTruthy();
    const submit = screen.getByRole('button', { name: /submit reference/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('UPI reference'), { target: { value: 'utr123456789' } });
    fireEvent.click(submit);
    await waitFor(() => expect(m.submitUtr).toHaveBeenCalledWith('order-1', 'utr123456789'));
    expect(await screen.findByText(/waiting for the shop to confirm/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /cancel order/i })).toBeNull();
  });

  it('cancels a new order and shows a duplicate-reference error in words', async () => {
    m.myOrder.mockResolvedValue(order());
    m.cancelOrder.mockImplementation(async () => { m.myOrder.mockResolvedValue(order({ status: 'CANCELLED' })); return order({ status: 'CANCELLED' }); });
    renderAt('/app/orders/order-1');
    fireEvent.click(await screen.findByRole('button', { name: /cancel order/i }));
    expect(await screen.findByText('Cancelled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /cancel order/i })).toBeNull();
  });

  it('offers a review once printing started, submits the rating, and then thanks the customer', async () => {
    m.myOrder.mockResolvedValue(order({ status: 'PRINTING' }));
    m.reviewOrder.mockImplementation(async () => { m.myOrder.mockResolvedValue(order({ status: 'PRINTING', isReviewed: true })); return { id: 'r', rating: 4, comment: null, customerName: 'Asha', createdAt: '' }; });
    renderAt('/app/orders/order-1');
    const submit = (await screen.findByRole('button', { name: /submit review/i })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));
    fireEvent.click(submit);
    await waitFor(() => expect(m.reviewOrder).toHaveBeenCalledWith('order-1', 4, ''));
    expect(await screen.findByText(/thanks for your review/i)).toBeTruthy();
  });

  it('does not offer a review for rejected or new orders', async () => {
    m.myOrder.mockResolvedValue(order({ status: 'REJECTED' }));
    renderAt('/app/orders/order-1');
    expect(await screen.findByText('Rejected by the shop')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /submit review/i })).toBeNull();
  });
});

describe('notifications', () => {
  it('shows unread items and marks them read', async () => {
    const n = { id: 'n1', type: 'orderStatus' as const, title: 'Order rejected', body: 'The shop could not take order RAMESH-0001.', orderId: 'order-1', readAt: null, createdAt: '2026-10-28T10:00:00Z' };
    m.notifications.mockResolvedValueOnce({ items: [n], page: 1, limit: 20, total: 1, unreadCount: 1 });
    m.notifications.mockResolvedValue({ items: [{ ...n, readAt: '2026-10-28T10:05:00Z' }], page: 1, limit: 20, total: 1, unreadCount: 0 });
    m.markRead.mockResolvedValue(undefined);
    renderAt('/app/notifications');
    expect(await screen.findByText('Order rejected')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View order' }).getAttribute('href')).toBe('/app/orders/order-1');
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(m.markRead).toHaveBeenCalledWith('n1'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark read' })).toBeNull());
  });
});
