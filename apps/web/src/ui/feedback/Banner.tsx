import type { ReactNode } from 'react';
import { IconButton } from '../actions/IconButton';
import { cx } from '../cx';
import { Icon, type IconName } from '../icons/Icon';
import './feedback.css';

export type BannerTone = 'info' | 'ok' | 'warn' | 'err';

const DEFAULT_ICON: Record<BannerTone, IconName> = { info: 'info', ok: 'circle-check', warn: 'triangle-alert', err: 'triangle-alert' };

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Icon override, or `false` for none. Defaults by tone. */
  icon?: IconName | false;
  /** Ordered recovery steps (rendered as an `ol`), e.g. "Check the PC is switched on". */
  steps?: ReadonlyArray<ReactNode>;
  /** Buttons/links, rendered after the text (Retry, Check again). */
  actions?: ReactNode;
  onDismiss?: () => void;
  /** `box` is an inline card; `bar` is a full-width strip (e.g. sticky past-due notice). */
  layout?: 'box' | 'bar';
  className?: string;
}

/**
 * Inline message. Errors use role="alert"; everything else role="status" so it is announced politely.
 * Say what happened and the fix; keep the user's input.
 */
export function Banner({ tone = 'info', title, children, icon, steps, actions, onDismiss, layout = 'box', className }: BannerProps) {
  const iconName = icon === undefined ? DEFAULT_ICON[tone] : icon;
  return (
    <div className={cx('pb-banner', `pb-banner--${tone}`, layout === 'bar' && 'pb-banner--bar', className)} role={tone === 'err' ? 'alert' : 'status'}>
      {iconName && <Icon name={iconName} size={20} className="pb-banner__icon" />}
      <div className="pb-banner__body">
        {title && <p className="pb-banner__title">{title}</p>}
        {children && <div className="pb-banner__text">{children}</div>}
        {steps && steps.length > 0 && (
          <ol className="pb-banner__steps">
            {steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        )}
        {actions && layout === 'box' && <div className="pb-banner__actions">{actions}</div>}
      </div>
      {actions && layout === 'bar' && <div className="pb-banner__actions">{actions}</div>}
      {onDismiss && <IconButton icon="x" label="Dismiss" size="sm" onClick={onDismiss} className="pb-banner__dismiss" />}
    </div>
  );
}
