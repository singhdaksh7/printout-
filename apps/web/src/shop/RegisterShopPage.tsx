import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { getMyProfile } from '../lib/shop-api';
import { Banner, BrandLogo, Button, Card, TextField } from '../ui';
import { useAuth } from './auth';

export const PINCODE_REGEX = /^[1-9][0-9]{5}$/;

export function onboardingErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'EMAIL_UNAVAILABLE':
        return 'An account with this email address already exists. Sign in with email and password, then link your Google account in Settings.';
      case 'ALREADY_ONBOARDED':
      case 'GOOGLE_IDENTITY_UNAVAILABLE':
        return 'This Google account has already registered a shop. Sign in to access your shop dashboard.';
      case 'SELF_ONBOARDING_DISABLED':
        return 'Shop self-registration is currently closed. Please contact Printout Buddy support to set up your shop.';
      case 'RATE_LIMITED':
        return 'Too many attempts. Please wait a minute and try again.';
      case 'NETWORK_ERROR':
        return 'Cannot reach the server. Check your connection and try again.';
      case 'VALIDATION_ERROR':
        return e.message || 'Please check the details you entered and try again.';
      case 'UNAUTHORIZED':
        return 'Your onboarding session expired. Please sign in with Google again.';
    }
    if (e.status === 429) return 'Too many attempts. Please wait a minute and try again.';
    if (e.status >= 500) return 'The server encountered an error. Please try again shortly.';
  }
  return 'Could not register your shop. Please verify your information and try again.';
}

export default function RegisterShopPage() {
  const { state, onboard, logout } = useAuth();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [googleEmail, setGoogleEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [shopName, setShopName] = useState('');
  const [address, setAddress] = useState('');
  const [pincode, setPincode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    ownerName?: string;
    shopName?: string;
    address?: string;
    pincode?: string;
  }>({});

  useEffect(() => {
    let alive = true;
    if (state.status === 'authed') {
      setLoading(false);
      return;
    }

    getMyProfile()
      .then((profile) => {
        if (!alive) return;
        if (profile.isShopRegisteredAtLeastOne || (profile.nextStep && profile.nextStep !== 'create_shop')) {
          navigate('/shop', { replace: true });
          return;
        }
        if (profile.user.email) {
          setGoogleEmail(profile.user.email);
        }
        if (profile.user.name && !ownerName) {
          setOwnerName(profile.user.name);
        }
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) {
          // No active onboarding grant or session
          navigate('/shop/login', { replace: true, state: { expired: true } });
        } else {
          setError(onboardingErrorMessage(e));
          setLoading(false);
        }
      });

    return () => {
      alive = false;
    };
  }, [state.status, navigate]);

  if (state.status === 'authed' && !busy) {
    return <Navigate to="/shop" replace />;
  }

  function validate(): boolean {
    const errs: typeof fieldErrors = {};
    if (!ownerName.trim()) {
      errs.ownerName = 'Owner name is required.';
    } else if (ownerName.trim().length > 100) {
      errs.ownerName = 'Owner name must be 100 characters or less.';
    }

    if (!shopName.trim()) {
      errs.shopName = 'Shop name is required.';
    } else if (shopName.trim().length < 2) {
      errs.shopName = 'Shop name must be at least 2 characters.';
    } else if (shopName.trim().length > 100) {
      errs.shopName = 'Shop name must be 100 characters or less.';
    }

    if (!address.trim()) {
      errs.address = 'Shop address is required.';
    } else if (address.trim().length < 5) {
      errs.address = 'Please provide a complete address (at least 5 characters).';
    } else if (address.trim().length > 300) {
      errs.address = 'Address must be 300 characters or less.';
    }

    if (!pincode.trim()) {
      errs.pincode = 'PIN code is required.';
    } else if (!PINCODE_REGEX.test(pincode.trim())) {
      errs.pincode = 'Enter a valid 6-digit Indian PIN code (e.g. 110001).';
    }

    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (!validate()) return;

    setBusy(true);
    try {
      await onboard({
        ownerName: ownerName.trim(),
        shopName: shopName.trim(),
        address: address.trim(),
        pincode: pincode.trim(),
        ...(googleEmail ? { email: googleEmail } : {})
      });
      navigate('/shop', { replace: true });
    } catch (err) {
      setError(onboardingErrorMessage(err));
      setBusy(false);
    }
  }

  async function handleCancel() {
    await logout();
    navigate('/shop/login', { replace: true });
  }

  return (
    <div className="pb-theme pb-login">
      <div className="pb-login__brand">
        <BrandLogo />
      </div>
      <Card as="section" className="pb-login__card" style={{ maxWidth: 480 }}>
        {loading ? (
          <div style={{ padding: '2rem 1rem', textAlign: 'center' }} role="status">
            <p className="pb-muted">Setting up your shop registration…</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} aria-labelledby="register-title" noValidate className="pb-login__form">
            <div>
              <h1 id="register-title" className="pb-h1">
                Register Your Shop
              </h1>
              <p className="pb-muted pb-pagehead__sub">
                Complete your details to set up your print shop on Printout Buddy.
              </p>
            </div>

            {googleEmail && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.625rem 0.875rem',
                  background: 'var(--pb-color-surface-subtle, #f8fafc)',
                  border: '1px solid var(--pb-color-border-subtle, #e2e8f0)',
                  borderRadius: 'var(--pb-radius-md, 8px)',
                  fontSize: '0.875rem',
                  color: 'var(--pb-color-text-subtle, #475569)'
                }}
              >
                <span>Google Account:</span>
                <strong style={{ color: 'var(--pb-color-text, #0f172a)' }}>{googleEmail}</strong>
              </div>
            )}

            {error && <Banner tone="err">{error}</Banner>}

            <TextField
              label="Owner Name"
              required
              value={ownerName}
              onChange={(e) => {
                setOwnerName(e.target.value);
                if (fieldErrors.ownerName) setFieldErrors((prev) => ({ ...prev, ownerName: undefined }));
              }}
              error={fieldErrors.ownerName}
              disabled={busy}
              maxLength={100}
              autoComplete="name"
            />

            <TextField
              label="Shop Name"
              required
              value={shopName}
              onChange={(e) => {
                setShopName(e.target.value);
                if (fieldErrors.shopName) setFieldErrors((prev) => ({ ...prev, shopName: undefined }));
              }}
              error={fieldErrors.shopName}
              disabled={busy}
              maxLength={100}
              placeholder="e.g. Apex Print Solutions"
              autoComplete="organization"
            />

            <TextField
              label="Shop Address"
              required
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                if (fieldErrors.address) setFieldErrors((prev) => ({ ...prev, address: undefined }));
              }}
              error={fieldErrors.address}
              disabled={busy}
              maxLength={300}
              placeholder="Shop number, street, landmark, city"
              autoComplete="street-address"
            />

            <TextField
              label="PIN Code"
              required
              value={pincode}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                setPincode(val);
                if (fieldErrors.pincode) setFieldErrors((prev) => ({ ...prev, pincode: undefined }));
              }}
              error={fieldErrors.pincode}
              disabled={busy}
              maxLength={6}
              inputMode="numeric"
              placeholder="6-digit PIN code (e.g. 110001)"
              autoComplete="postal-code"
            />

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
              <Button type="submit" variant="primary" fullWidth disabled={busy} loading={busy}>
                {busy ? 'Creating shop…' : 'Register Shop'}
              </Button>
              <Button type="button" variant="outline" fullWidth disabled={busy} onClick={handleCancel}>
                Use a different account
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
