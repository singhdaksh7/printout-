import { useCallback, useEffect, useState } from 'react';
import { describeError, getHours, getSettings, putSettings, type ShopSettings } from '../lib/shop-api';
import type { Availability } from '../lib/hours';
import { Button, Chip, type ChipTone } from '../ui';

export type ShopState = 'suspended' | 'unverified' | 'closed' | 'open';

/** Admin-controlled states win; verification next; then the owner's own availability. They are three separate concepts. */
export function deriveShopState(s: ShopSettings, availability?: Availability | null): { state: ShopState; label: string; tone: ChipTone } {
  if (s.shopStatus === 'SUSPENDED' || s.shopStatus === 'CANCELLED') return { state: 'suspended', label: 'Suspended', tone: 'err' };
  if (s.isVerified === false) return { state: 'unverified', label: 'Awaiting verification', tone: 'warn' };
  if (s.acceptsOrders === false || availability?.state === 'closed') return { state: 'closed', label: 'Closed', tone: 'neutral' };
  return { state: 'open', label: 'Open', tone: 'ok' };
}

/** Status of the signed-in owner's current shop, shown above every dashboard page. Only "accepting orders" is owner-editable. */
export function ShopStatusBar({ shopName }: { shopName: string }) {
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getSettings().then((s) => { setSettings(s); setError(null); }).catch((e) => setError(describeError(e)));
    getHours().then((h) => setAvailability(h.availability)).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  if (!settings) return null; // status is supplementary: pages report their own load errors
  const st = deriveShopState(settings, availability);
  const canToggle = st.state === 'open' || (st.state === 'closed' && settings.acceptsOrders === false);

  async function toggle() {
    if (busy || !settings) return;
    setBusy(true); setError(null);
    try { setSettings({ ...settings, ...(await putSettings({ acceptsOrders: !settings.acceptsOrders })) }); }
    catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="pb-statusbar" role="region" aria-label="Shop status" data-testid="shop-status">
      <strong className="pb-ellipsis">{shopName}</strong>
      <Chip tone={st.tone} data-testid="shop-status-chip">{st.label}</Chip>
      {canToggle && (
        <Button variant="outline" size="sm" onClick={toggle} loading={busy} disabled={busy}>
          {settings.acceptsOrders === false ? 'Open shop' : 'Close shop'}
        </Button>
      )}
      {error && <span role="alert" className="pb-statusbar__err">{error}</span>}
    </div>
  );
}
