import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import * as shopApi from '../../lib/shop-api';
import RegisterShopPage from '../RegisterShopPage';
import { AuthProvider } from '../auth';

vi.mock('../../lib/shop-api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/shop-api')>('../../lib/shop-api');
  return {
    ...actual,
    fetchSession: vi.fn(),
    getMyProfile: vi.fn(),
    onboardShop: vi.fn(),
    logout: vi.fn()
  };
});

describe('RegisterShopPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shopApi.fetchSession).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Not authenticated'));
  });

  const renderPage = (initialEntries = ['/shop/register']) => {
    return render(
      <MemoryRouter initialEntries={initialEntries}>
        <AuthProvider>
          <Routes>
            <Route path="/shop/register" element={<RegisterShopPage />} />
            <Route path="/shop" element={<div data-testid="shop-dashboard">Shop Dashboard</div>} />
            <Route path="/shop/login" element={<div data-testid="shop-login">Shop Login</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
  };

  it('renders registration form with verified Google email when onboarding grant is active', async () => {
    vi.mocked(shopApi.getMyProfile).mockResolvedValue({
      user: {
        id: null,
        role: null,
        name: 'Anita Verma',
        email: 'anita@gmail.com',
        phoneNumber: null,
        loginMethods: ['google'],
        emailVerified: true,
        phoneVerified: false,
        createdAt: null,
        updatedAt: null,
        lastLoginAt: null
      },
      shops: [],
      shop: null,
      nextStep: 'create_shop',
      isShopRegisteredAtLeastOne: false,
      showQr: false,
      onboardingAvailable: true
    });

    renderPage();

    expect(screen.getByText('Setting up your shop registration…')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Register Your Shop' })).toBeInTheDocument();
    });

    expect(screen.getByText('anita@gmail.com')).toBeInTheDocument();
    expect(screen.getByLabelText(/Owner Name/i)).toHaveValue('Anita Verma');
    expect(screen.getByLabelText(/Shop Name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Shop Address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/PIN Code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register Shop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use a different account' })).toBeInTheDocument();
  });

  it('redirects to /shop/login when no onboarding grant exists (401 from /users/me)', async () => {
    vi.mocked(shopApi.getMyProfile).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Authentication required'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('shop-login')).toBeInTheDocument();
    });
  });

  it('redirects to /shop if user already has a registered shop', async () => {
    vi.mocked(shopApi.getMyProfile).mockResolvedValue({
      user: {
        id: 'usr-1',
        role: 'shop',
        name: 'Owner',
        email: 'owner@gmail.com',
        phoneNumber: null,
        loginMethods: ['google'],
        emailVerified: true,
        phoneVerified: false,
        createdAt: null,
        updatedAt: null,
        lastLoginAt: null
      },
      shops: [{ id: 'shp-1', shopName: 'Existing Shop', slug: 'existing-shop', status: 'ACTIVE' }],
      shop: { id: 'shp-1', shopName: 'Existing Shop', slug: 'existing-shop', status: 'ACTIVE' },
      nextStep: 'complete',
      isShopRegisteredAtLeastOne: true,
      showQr: true,
      onboardingAvailable: true
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('shop-dashboard')).toBeInTheDocument();
    });
  });

  it('validates required fields before submitting', async () => {
    vi.mocked(shopApi.getMyProfile).mockResolvedValue({
      user: {
        id: null,
        role: null,
        name: null,
        email: 'newbie@gmail.com',
        phoneNumber: null,
        loginMethods: ['google'],
        emailVerified: true,
        phoneVerified: false,
        createdAt: null,
        updatedAt: null,
        lastLoginAt: null
      },
      shops: [],
      shop: null,
      nextStep: 'create_shop',
      isShopRegisteredAtLeastOne: false,
      showQr: false,
      onboardingAvailable: true
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Register Your Shop' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Register Shop' }));

    await waitFor(() => {
      expect(screen.getByText('Owner name is required.')).toBeInTheDocument();
      expect(screen.getByText('Shop name is required.')).toBeInTheDocument();
      expect(screen.getByText('Shop address is required.')).toBeInTheDocument();
      expect(screen.getByText('PIN code is required.')).toBeInTheDocument();
    });

    expect(shopApi.onboardShop).not.toHaveBeenCalled();
  });

  it('validates invalid PIN code format', async () => {
    vi.mocked(shopApi.getMyProfile).mockResolvedValue({
      user: {
        id: null,
        role: null,
        name: 'Tester',
        email: 'test@gmail.com',
        phoneNumber: null,
        loginMethods: ['google'],
        emailVerified: true,
        phoneVerified: false,
        createdAt: null,
        updatedAt: null,
        lastLoginAt: null
      },
      shops: [],
      shop: null,
      nextStep: 'create_shop',
      isShopRegisteredAtLeastOne: false,
      showQr: false,
      onboardingAvailable: true
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Register Your Shop' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Shop Name/i), { target: { value: 'Test Prints' } });
    fireEvent.change(screen.getByLabelText(/Shop Address/i), { target: { value: '123 Market Street' } });
    fireEvent.change(screen.getByLabelText(/PIN Code/i), { target: { value: '012345' } }); // Starts with 0

    fireEvent.click(screen.getByRole('button', { name: 'Register Shop' }));

    await waitFor(() => {
      expect(screen.getByText('Enter a valid 6-digit Indian PIN code (e.g. 110001).')).toBeInTheDocument();
    });
  });

  it('submits valid form, transitions to authed session, and navigates to /shop', async () => {
    vi.mocked(shopApi.getMyProfile).mockResolvedValue({
      user: {
        id: null,
        role: null,
        name: 'Rajesh Kumar',
        email: 'rajesh@gmail.com',
        phoneNumber: null,
        loginMethods: ['google'],
        emailVerified: true,
        phoneVerified: false,
        createdAt: null,
        updatedAt: null,
        lastLoginAt: null
      },
      shops: [],
      shop: null,
      nextStep: 'create_shop',
      isShopRegisteredAtLeastOne: false,
      showQr: false,
      onboardingAvailable: true
    });

    vi.mocked(shopApi.onboardShop).mockResolvedValue({
      user: { id: 'usr-new-123', role: 'shop', name: 'Rajesh Kumar', email: 'rajesh@gmail.com' },
      shop: { id: 'shp-new-456', shopName: 'Rajesh Copies', slug: 'rajesh-copies-abcd', status: 'PILOT' },
      csrfToken: 'csrf-new-session',
      retentionMinutes: 30
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Register Your Shop' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Shop Name/i), { target: { value: 'Rajesh Copies' } });
    fireEvent.change(screen.getByLabelText(/Shop Address/i), { target: { value: 'Station Road, Shop 5' } });
    fireEvent.change(screen.getByLabelText(/PIN Code/i), { target: { value: '110001' } });

    fireEvent.click(screen.getByRole('button', { name: 'Register Shop' }));

    await waitFor(() => {
      expect(shopApi.onboardShop).toHaveBeenCalledWith({
        ownerName: 'Rajesh Kumar',
        shopName: 'Rajesh Copies',
        address: 'Station Road, Shop 5',
        pincode: '110001',
        email: 'rajesh@gmail.com'
      });
      expect(screen.getByTestId('shop-dashboard')).toBeInTheDocument();
    });
  });

  it('displays clear error banner on email conflict (EMAIL_UNAVAILABLE)', async () => {
    vi.mocked(shopApi.getMyProfile).mockResolvedValue({
      user: {
        id: null,
        role: null,
        name: 'Colliding User',
        email: 'existing@printoutbuddy.tech',
        phoneNumber: null,
        loginMethods: ['google'],
        emailVerified: true,
        phoneVerified: false,
        createdAt: null,
        updatedAt: null,
        lastLoginAt: null
      },
      shops: [],
      shop: null,
      nextStep: 'create_shop',
      isShopRegisteredAtLeastOne: false,
      showQr: false,
      onboardingAvailable: true
    });

    vi.mocked(shopApi.onboardShop).mockRejectedValue(
      new ApiError(409, 'EMAIL_UNAVAILABLE', 'This email address cannot be used. Choose a different one.')
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Register Your Shop' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Shop Name/i), { target: { value: 'Colliding Prints' } });
    fireEvent.change(screen.getByLabelText(/Shop Address/i), { target: { value: '123 Test Street' } });
    fireEvent.change(screen.getByLabelText(/PIN Code/i), { target: { value: '110001' } });

    fireEvent.click(screen.getByRole('button', { name: 'Register Shop' }));

    await waitFor(() => {
      expect(
        screen.getByText('An account with this email address already exists. Sign in with email and password, then link your Google account in Settings.')
      ).toBeInTheDocument();
    });
  });

  it('cancel button calls logout and navigates to /shop/login', async () => {
    vi.mocked(shopApi.getMyProfile).mockResolvedValue({
      user: {
        id: null,
        role: null,
        name: 'Tester',
        email: 'cancel@gmail.com',
        phoneNumber: null,
        loginMethods: ['google'],
        emailVerified: true,
        phoneVerified: false,
        createdAt: null,
        updatedAt: null,
        lastLoginAt: null
      },
      shops: [],
      shop: null,
      nextStep: 'create_shop',
      isShopRegisteredAtLeastOne: false,
      showQr: false,
      onboardingAvailable: true
    });
    vi.mocked(shopApi.logout).mockResolvedValue(undefined);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Register Your Shop' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));

    await waitFor(() => {
      expect(shopApi.logout).toHaveBeenCalled();
      expect(screen.getByTestId('shop-login')).toBeInTheDocument();
    });
  });
});
