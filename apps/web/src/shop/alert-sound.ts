import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { safeStorage } from './hooks';

/**
 * New-order sound. One preference and one player for the whole shop UI.
 *
 * - Off by default; only an explicit opt-in switches it on. The preference (per browser, because audio permission is per
 *   browser) lives under the key the Print queue checkbox always used, so existing opt-ins are preserved.
 * - Browsers refuse audio that was not started by a user gesture. The audio context is therefore created/resumed inside
 *   the opt-in click (and on the next click/key press after a page load); if it is still not running when an order
 *   arrives the chime is skipped and `blocked` is reported so the UI can ask the user to re-enable it. Never a retry loop.
 * - `playNewOrderChime` is only called for live notifications; replays, refreshes and reconnect catch-up never sound.
 */
export const SOUND_KEY = 'printout.shop.sound';
const MIN_GAP_MS = 3000;

type Listener = () => void;
const listeners = new Set<Listener>();
let ctx: AudioContext | null = null;
let lastPlayedAt = 0;
let blockedFlag = false;

const notify = () => listeners.forEach((l) => l());
const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function isSoundEnabled(): boolean {
  return safeStorage()?.getItem(SOUND_KEY) === '1';
}

function audioCtor(): (new () => AudioContext) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Create/resume the audio context. Call from a user gesture (click / key press). Resolves to whether audio can play. */
export async function unlockAudio(): Promise<boolean> {
  try {
    const Ctor = audioCtor();
    if (!Ctor) return false;
    ctx ??= new Ctor();
    if (ctx.state !== 'running') await ctx.resume();
    const ok = ctx.state === 'running';
    if (ok && blockedFlag) { blockedFlag = false; notify(); }
    return ok;
  } catch {
    return false;
  }
}

export function setSoundEnabled(on: boolean): void {
  try { safeStorage()?.setItem(SOUND_KEY, on ? '1' : '0'); } catch { /* preference is best effort */ }
  if (on) void unlockAudio(); else if (blockedFlag) blockedFlag = false;
  notify();
}

export type ChimeResult = 'played' | 'off' | 'blocked' | 'throttled' | 'unavailable';

/** Plays the short two-tone chime if (and only if) the user opted in and the browser allows audio right now. */
export function playNewOrderChime(now = Date.now()): ChimeResult {
  if (!isSoundEnabled()) return 'off';
  if (!audioCtor()) return 'unavailable';
  if (now - lastPlayedAt < MIN_GAP_MS) return 'throttled';
  if (!ctx || ctx.state !== 'running') {
    if (!blockedFlag) { blockedFlag = true; notify(); }
    return 'blocked';
  }
  try {
    const t = ctx.currentTime;
    for (const [i, freq] of [880, 1175].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.06, t + i * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t + i * 0.16);
      osc.stop(t + i * 0.16 + 0.16);
    }
    lastPlayedAt = now;
    return 'played';
  } catch {
    return 'unavailable';
  }
}

/** Reactive preference for any component. `blocked` = on, but the browser has not allowed audio yet. */
export function useAlertSound() {
  const enabled = useSyncExternalStore(subscribe, isSoundEnabled, () => false);
  const blocked = useSyncExternalStore(subscribe, () => blockedFlag, () => false);

  // Another tab changed the preference.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === SOUND_KEY) notify(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // After a page load audio is locked again: unlock on the first gesture while the sound is on.
  useEffect(() => {
    if (!enabled) return;
    const unlock = () => { void unlockAudio(); };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, [enabled]);

  const set = useCallback((on: boolean) => setSoundEnabled(on), []);
  const test = useCallback(async () => { if (await unlockAudio()) { lastPlayedAt = 0; playNewOrderChime(); } }, []);
  return { enabled, blocked, set, test };
}

/** Test hook: forget the shared audio state. */
export function resetAlertSoundForTests(): void {
  ctx = null; lastPlayedAt = 0; blockedFlag = false; listeners.clear();
}
