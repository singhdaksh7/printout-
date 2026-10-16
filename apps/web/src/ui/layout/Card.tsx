import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';
import { Skeleton } from '../feedback/Skeleton';
import { Badge } from '../status/Badge';
import './layout.css';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Element to render. Use `section` with a `CardHeader` title so the card is a labelled landmark-like group. */
  as?: ElementType;
  padding?: 'none' | 'sm' | 'md';
  /** Coloured left border for cards that need attention (admin KPI tiles, alerts). */
  accent?: 'warn' | 'err';
}

/** White surface, 16px radius, n200 border. No shadow: shadows are for overlays only. */
export function Card({ as: Tag = 'div', padding = 'md', accent, className, ...rest }: CardProps) {
  return <Tag className={cx('pb-card', `pb-card--pad-${padding}`, accent && `pb-card--${accent}`, className)} {...rest} />;
}

export interface CardHeaderProps {
  title: ReactNode;
  /** Heading element, default h2. Pick the level that fits the page outline. */
  as?: 'h2' | 'h3' | 'h4';
  /** Secondary text on the right (e.g. "4 open", "Sorted by jobs today"). */
  meta?: ReactNode;
  actions?: ReactNode;
  id?: string;
}

export function CardHeader({ title, as: Tag = 'h2', meta, actions, id }: CardHeaderProps) {
  return (
    <div className="pb-card__header">
      <Tag id={id} className="pb-card__title">{title}</Tag>
      {meta && <span className="pb-card__meta">{meta}</span>}
      {actions && <div className="pb-card__actions">{actions}</div>}
    </div>
  );
}

export interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: 'warn' | 'err';
  /** Small caps tag next to the label, e.g. "Sample" for placeholder data. Never imply live data that is not live. */
  tag?: string;
  loading?: boolean;
  className?: string;
}

/** KPI tile: label, large number (Rubik 700), hint. */
export function StatTile({ label, value, hint, accent, tag, loading, className }: StatTileProps) {
  return (
    <Card padding="sm" accent={accent} className={cx('pb-stat', className)} aria-busy={loading || undefined}>
      <p className="pb-stat__label">
        {label}
        {tag && <Badge tone="warn" caps className="pb-stat__tag">{tag}</Badge>}
      </p>
      {loading ? (
        <>
          <Skeleton variant="block" width={64} height={28} />
          <span className="pb-sr-only" role="status">Loading {label}</span>
        </>
      ) : (
        <p className="pb-stat__value pb-tnum">{value}</p>
      )}
      {hint && !loading && <p className="pb-stat__hint">{hint}</p>}
    </Card>
  );
}
