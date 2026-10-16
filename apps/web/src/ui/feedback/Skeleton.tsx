import type { CSSProperties } from 'react';
import { cx } from '../cx';
import './feedback.css';

export interface SkeletonProps {
  /** `text`: stacked lines inside a labelled loading region. `block`: one decorative rectangle (stat, avatar, table cell). */
  variant?: 'text' | 'block';
  lines?: number;
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  /** Accessible name of the loading region (text variant). */
  label?: string;
  className?: string;
}

/** Placeholder for layout we know is coming. Use ProgressBar only for real progress. */
export function Skeleton({ variant = 'text', lines = 3, width, height, label = 'Loading', className }: SkeletonProps) {
  if (variant === 'block') {
    return <span aria-hidden="true" className={cx('pb-skel', 'pb-skel--block', className)} style={{ width, height }} />;
  }
  return (
    <div className={cx('pb-skel-group', className)} role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} aria-hidden="true" className="pb-skel pb-skel--line" style={{ width: width ?? `${90 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}
