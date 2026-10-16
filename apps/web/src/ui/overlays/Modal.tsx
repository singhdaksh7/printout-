import { useId, type ReactNode, type RefObject } from 'react';
import { cx } from '../cx';
import { Icon } from '../icons/Icon';
import { useFocusTrap } from './useFocusTrap';
import './overlays.css';

export interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Buttons row (right aligned). Keep the safe action first ("Keep job"), the destructive one last. */
  footer?: ReactNode;
  /** `danger` adds a lock/alert treatment for irreversible actions (suspend shop, cancel job). */
  tone?: 'default' | 'danger';
  size?: 'sm' | 'md';
  /** Short badge above the title, e.g. a Chip showing "Suspended". */
  eyebrow?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement>;
  /** Request in flight: Escape and scrim click are ignored. */
  busy?: boolean;
}

/**
 * Centred dialog. Rendered only while open (mount = open). Traps focus, closes on Escape or scrim click
 * (unless busy) and returns focus to the control that opened it.
 */
export function Modal({ title, children, onClose, footer, tone = 'default', size = 'md', eyebrow, initialFocusRef, busy }: ModalProps) {
  const titleId = useId();
  const { ref, onKeyDown } = useFocusTrap<HTMLDivElement>({ onEscape: onClose, busy, initialFocusRef });
  return (
    <div className="pb-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={ref} className={cx('pb-modal', `pb-modal--${size}`, tone === 'danger' && 'pb-modal--danger')} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} onKeyDown={onKeyDown} tabIndex={-1}>
        {(eyebrow || tone === 'danger') && (
          <div className="pb-modal__eyebrow">
            {tone === 'danger' && !eyebrow ? <Icon name="triangle-alert" size={18} /> : null}
            {eyebrow}
          </div>
        )}
        <h2 id={titleId} className="pb-modal__title">{title}</h2>
        <div className="pb-modal__body">{children}</div>
        {footer && <div className="pb-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
