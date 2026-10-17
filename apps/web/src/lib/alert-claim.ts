import { safeStorage } from '../shop/hooks';

/**
 * Several tabs of the same shop each receive every live notification. Only one of them should toast and sound.
 * The tabs agree through localStorage: the highest notification seq already alerted is stored, and a tab alerts only
 * when it can raise that value. A visible tab claims immediately, hidden tabs wait a moment so the one the user is
 * looking at wins. Atomic via Web Locks where available (older browsers fall back to a best-effort check); storage failure falls
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

/** Compare-and-set made atomic across tabs with the Web Locks API when the browser has it. */
function claimAtomically(seq: string, onResult: (mine: boolean) => void): void {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return onResult(tryClaim(seq));
  locks.request('printout-shop-alert-claim', () => tryClaim(seq)).then(onResult, () => onResult(true));
}

/** Calls back with true when THIS tab should alert for the notification. Cancel via the returned function. */
export function claimAlert(seq: string, onResult: (mine: boolean) => void): () => void {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (!hidden) {
    claimAtomically(seq, onResult);
    return () => undefined;
  }
  const t = setTimeout(() => claimAtomically(seq, onResult), HIDDEN_DELAY_MS);
  return () => clearTimeout(t);
}
