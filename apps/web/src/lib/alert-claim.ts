import { safeStorage } from '../shop/hooks';

/**
 * Several tabs of the same shop each receive every live notification. Only one of them should toast and sound.
 * The tabs agree through localStorage: the highest notification seq already alerted is stored, and a tab alerts only
 * when it can raise that value. A visible tab claims immediately, hidden tabs wait a moment so the one the user is
 * looking at wins. Best effort (two tabs racing within the same millisecond could both alert); storage failure falls
 * back to "alert", never to silence.
 */
export const CLAIM_KEY = 'printout.shop.lastAlertedSeq';
const HIDDEN_DELAY_MS = 350;

function tryClaim(seq: string): boolean {
  const store = safeStorage();
  if (!store) return true;
  try {
    const current = store.getItem(CLAIM_KEY);
    if (current && /^\d{1,18}$/.test(current) && BigInt(current) >= BigInt(seq)) return false;
    store.setItem(CLAIM_KEY, seq);
    return true;
  } catch {
    return true;
  }
}

/** Resolves to true when THIS tab should alert for the notification. Cancel via the returned `cancel`. */
export function claimAlert(seq: string, onResult: (mine: boolean) => void): () => void {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (!hidden) {
    onResult(tryClaim(seq));
    return () => undefined;
  }
  const t = setTimeout(() => onResult(tryClaim(seq)), HIDDEN_DELAY_MS);
  return () => clearTimeout(t);
}
