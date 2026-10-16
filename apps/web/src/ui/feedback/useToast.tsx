import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ToastRegion } from './ToastRegion';

/**
 * Transient confirmation message: `show('Order cancelled')` then render `node` once in the page.
 * Per the design system, confirm with a toast (or a status chip), never a modal. The message clears itself.
 */
export function useToast(durationMs = 4000) {
  const [message, setMessage] = useState<ReactNode | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const show = useCallback((m: ReactNode) => {
    setMessage(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), durationMs);
  }, [durationMs]);
  return { show, node: <ToastRegion message={message} /> };
}
