import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface FocusTrapOptions {
  onEscape: () => void;
  /** While busy (e.g. a request is in flight) Escape and scrim clicks do nothing. */
  busy?: boolean | undefined;
  initialFocusRef?: RefObject<HTMLElement> | undefined;
}

/**
 * Focus management shared by Modal and Drawer: focuses the first control (or `initialFocusRef`) on mount,
 * keeps Tab inside the dialog, closes on Escape, and returns focus to the opener on unmount.
 */
export function useFocusTrap<T extends HTMLElement>({ onEscape, busy, initialFocusRef }: FocusTrapOptions) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (initialFocusRef?.current ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current)?.focus();
    return () => opener?.focus?.();
  }, [initialFocusRef]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!busy) onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const els = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (!els.length) {
      e.preventDefault();
      return;
    }
    const first = els[0]!;
    const last = els[els.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  return { ref, onKeyDown };
}
