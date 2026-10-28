import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { PhoneAuthError, googleAuthErrorMessage } from '../lib/phone-auth';
import { formatPaise } from '../lib/format';
import { Banner, Button, Card, Chip, EmptyState, Select, Skeleton, TextField, buttonClass } from '../ui';
import { errorText, nearbyShops, shopDetail, shopReviews, type Page, type Review, type ShopCard } from './api';
import { useMarket } from './session';

export const cheapestSheet = (rates: ShopCard['rates']): number | null => (rates.length ? Math.min(...rates.map((r) => r.pricePerSheetPaise)) : null);
export const stars = (avg: number | null, count: number) => (avg === null || count === 0 ? 'No ratings yet' : `${avg.toFixed(1)} ★ (${count})`);

export function LoginPage() {
  const { state, signIn } = useMarket();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state.status === 'authed') return <Navigate to="/app" replace />;
  async function go() {
    setBusy(true);
    setError(null);
    try {
      navigate((await signIn()) === 'welcome' ? '/app/welcome' : '/app', { replace: true });
    } catch (e) {
      if (e instanceof PhoneAuthError) setError(e.kind === 'cancelled' ? null : googleAuthErrorMessage(e));
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mk-narrow">
      <h1 className="mk-h1">Print at a shop near you</h1>
      <p className="mk-muted">Upload a file, pick a nearby shop, and collect your prints. Sign in to continue.</p>
      {error && <Banner tone="err">{error}</Banner>}
      <Button variant="primary" size="lg" fullWidth loading={busy} onClick={go}>Continue with Google</Button>
      <p className="mk-small mk-muted">Shop owner? <Link to="/shop/login">Sign in to your shop</Link></p>
    </div>
  );
}

export function WelcomePage() {
  const { state, register } = useMarket();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state.status === 'authed') return <Navigate to="/app" replace />;
  if (state.status === 'anon') return <Navigate to="/app/login" replace />;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Enter your name.');
    setBusy(true);
    setError(null);
    try {
      await register(name.trim());
      navigate('/app', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="mk-narrow" onSubmit={submit} noValidate>
      <h1 className="mk-h1">Welcome</h1>
      <p className="mk-muted">What should shops call you?</p>
      {error && <Banner tone="err">{error}</Banner>}
      <TextField label="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="name" required />
      <Button type="submit" variant="primary" size="lg" fullWidth loading={busy}>Continue</Button>
    </form>
  );
}

function ShopRow({ shop }: { shop: ShopCard }) {
  const from = cheapestSheet(shop.rates);
  return (
    <li>
      <Card>
        <div className="mk-row mk-between">
          <h2 className="mk-h2"><Link to={`/app/shops/${shop.id}`}>{shop.shopName}</Link></h2>
          <Chip tone={shop.isOpen ? 'ok' : 'neutral'}>{shop.isOpen ? 'Open' : 'Closed'}</Chip>
        </div>
        <p className="mk-muted mk-small">{[shop.addressLine1, shop.city].filter(Boolean).join(', ')}</p>
        <p className="mk-small">
          {shop.distanceKm !== undefined && <span>{shop.distanceKm} km away · </span>}
          <span>{stars(shop.ratingAvg, shop.ratingCount)}</span>
          {from !== null && <span> · from {formatPaise(from)} per sheet</span>}
        </p>
      </Card>
    </li>
  );
}

export function NearbyPage() {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [radius, setRadius] = useState('5');
  const [colour, setColour] = useState('');
  const [data, setData] = useState<Page<ShopCard> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  const search = useCallback(async (c: { lat: number; lng: number }, r: string, type: string) => {
    setBusy(true);
    setError(null);
    try {
      setData(await nearbyShops({ ...c, radiusKm: Number(r), ...(type ? { printingType: type as 'colored' | 'blackWhite' } : {}) }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  function locate() {
    setGeoMsg(null);
    if (!navigator.geolocation) return setGeoMsg('Your browser cannot share your location.');
    navigator.geolocation.getCurrentPosition(
      (pos) => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setGeoMsg('Location is blocked. Allow location access in your browser to find shops near you.'),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 }
    );
  }
  useEffect(() => { if (coords) void search(coords, radius, colour); }, [coords, radius, colour, search]);

  return (
    <div className="mk-page">
      <h1 className="mk-h1">Shops near you</h1>
      {!coords && <Button variant="primary" onClick={locate}>Use my location</Button>}
      {geoMsg && <Banner tone="warn">{geoMsg}</Banner>}
      {coords && (
        <div className="mk-filters">
          <Select label="Distance" value={radius} onChange={(e) => setRadius(e.target.value)}>
            {['1', '5', '10', '20'].map((v) => <option key={v} value={v}>{v} km</option>)}
          </Select>
          <Select label="Printing" value={colour} onChange={(e) => setColour(e.target.value)}>
            <option value="">Any</option>
            <option value="blackWhite">Black and white</option>
            <option value="colored">Colour</option>
          </Select>
        </div>
      )}
      {error && <Banner tone="err" actions={coords ? <Button size="sm" onClick={() => void search(coords, radius, colour)}>Retry</Button> : undefined}>{error}</Banner>}
      {busy && <Skeleton variant="block" height={96} />}
      {data && !busy && (data.items.length === 0
        ? <EmptyState title="No shops here yet">Try a larger distance. Shops appear after they are verified.</EmptyState>
        : <ul className="mk-list">{data.items.map((s) => <ShopRow key={s.id} shop={s} />)}</ul>)}
    </div>
  );
}

export function ShopPage() {
  const { id = '' } = useParams();
  const [shop, setShop] = useState<(ShopCard & { location?: unknown }) | null>(null);
  const [reviews, setReviews] = useState<(Page<Review> & { ratingAvg: number | null; ratingCount: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    shopDetail(id).then((s) => alive.current && setShop(s)).catch((e) => alive.current && setError(errorText(e)));
    shopReviews(id).then((r) => alive.current && setReviews(r)).catch(() => undefined);
    return () => { alive.current = false; };
  }, [id]);
  if (error) return <div className="mk-page"><Banner tone="err">{error}</Banner><Link to="/app">Back to shops</Link></div>;
  if (!shop) return <div className="mk-page"><Skeleton variant="block" height={160} /></div>;
  const canOrder = shop.isOpen && !shop.availability.orderingBlocked;
  return (
    <div className="mk-page">
      <Link to="/app">&larr; Shops</Link>
      <div className="mk-row mk-between"><h1 className="mk-h1">{shop.shopName}</h1><Chip tone={shop.isOpen ? 'ok' : 'neutral'}>{shop.isOpen ? 'Open' : 'Closed'}</Chip></div>
      <p className="mk-muted">{[shop.addressLine1, shop.city, shop.pincode].filter(Boolean).join(', ')}</p>
      <p>{stars(shop.ratingAvg, shop.ratingCount)}</p>
      {!shop.isOpen && shop.availability.nextOpenAt && <Banner tone="info">Opens {new Date(shop.availability.nextOpenAt).toLocaleString()}</Banner>}
      <Card>
        <h2 className="mk-h2">Prices (per sheet)</h2>
        <ul className="mk-plain">
          {shop.rates.map((r) => <li key={`${r.colourMode}-${r.sides}`}>{r.colourMode === 'bw' ? 'Black and white' : 'Colour'}, {r.sides === 'single' ? 'single-sided' : 'double-sided'}: <strong>{formatPaise(r.pricePerSheetPaise)}</strong></li>)}
        </ul>
        <p className="mk-small mk-muted">Paper: {shop.paperSizes.join(', ') || 'A4'} · {shop.paperTypes.join(', ')}. Pay by {shop.acceptedPaymentMethods.map((m) => (m === 'cash' ? 'cash' : 'UPI')).join(' or ')}. The final price is confirmed when you order.</p>
      </Card>
      {canOrder
        ? <Link className={buttonClass({ variant: 'primary', size: 'lg', fullWidth: true })} to={`/app/shops/${shop.id}/order`}>Print here</Link>
        : <Button size="lg" fullWidth disabled>Not taking orders right now</Button>}
      <h2 className="mk-h2">Reviews</h2>
      {reviews && reviews.items.length === 0 && <p className="mk-muted">No reviews yet.</p>}
      <ul className="mk-list">
        {reviews?.items.map((r) => (
          <li key={r.id}><Card><p className="mk-small"><strong>{r.customerName}</strong> · {'★'.repeat(r.rating)}</p>{r.comment && <p>{r.comment}</p>}</Card></li>
        ))}
      </ul>
    </div>
  );
}
