import type { ReactNode } from 'react';
import { cx } from '../cx';
import { Icon, type IconName } from '../icons/Icon';
import './feedback.css';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  /** Heading element for the title; pick the level that fits the page outline. Default h3. */
  titleAs?: 'h2' | 'h3' | 'h4';
  /** Say what will appear here and how to get the first one. */
  children?: ReactNode;
  /** One action at most (design rule). */
  action?: ReactNode;
  /** Optional highlighted tip below the action (e.g. "Is the QR standee on the counter?"). */
  callout?: ReactNode;
  className?: string;
}

export function EmptyState({ icon = 'inbox', title, titleAs: Title = 'h3', children, action, callout, className }: EmptyStateProps) {
  return (
    <div className={cx('pb-empty', className)}>
      <Icon name={icon} size={40} className="pb-empty__icon" />
      <Title className="pb-empty__title">{title}</Title>
      {children && <div className="pb-empty__text">{children}</div>}
      {action && <div className="pb-empty__action">{action}</div>}
      {callout && <div className="pb-empty__callout">{callout}</div>}
    </div>
  );
}
