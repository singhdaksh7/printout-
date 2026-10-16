import { useId, type ReactNode, type RefObject } from 'react';
import { IconButton } from '../actions/IconButton';
import { cx } from '../cx';
import { useFocusTrap } from './useFocusTrap';
import './overlays.css';

export interface DrawerProps {
  /** Accessible name of the panel (visible header content is up to `header`). */
  title: string;
  /** Visible header, e.g. job code + status chip. Defaults to the title as text. */
  header?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /** Sticky action row at the bottom (Print, Cancel job). */
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement>;
  busy?: boolean;
  className?: string;
}

/**
 * Right-hand detail panel (job detail). Slides in over 250ms, is full screen on phones, traps focus, closes on
 * Escape or a click outside (unless busy). Rendered only while open.
 */
export function Drawer({ title, header, children, onClose, footer, initialFocusRef, busy, className }: DrawerProps) {
  const titleId = useId();
  const { ref, onKeyDown } = useFocusTrap<HTMLDivElement>({ onEscape: onClose, busy, initialFocusRef });
  return (
    <div className="pb-scrim pb-scrim--drawer" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={ref} className={cx('pb-drawer', className)} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} onKeyDown={onKeyDown} tabIndex={-1}>
        <div className="pb-drawer__header">
          <div id={titleId} className="pb-drawer__title">{header ?? title}</div>
          <IconButton icon="x" label="Close" onClick={onClose} disabled={busy} />
        </div>
        <div className="pb-drawer__body">{children}</div>
        {footer && <div className="pb-drawer__footer">{footer}</div>}
      </div>
    </div>
  );
}
