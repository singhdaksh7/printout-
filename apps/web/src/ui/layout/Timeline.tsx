import type { ReactNode } from 'react';
import { cx } from '../cx';
import './layout.css';

export interface TimelineItem {
  /** Time or date text, shown in the mono font (e.g. "18:41", "14 Oct"). */
  time: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'err';
}

export interface TimelineProps {
  items: ReadonlyArray<TimelineItem>;
  className?: string;
}

/** Vertical event list (newest first by convention): shop timeline, agent events, incident updates. */
export function Timeline({ items, className }: TimelineProps) {
  return (
    <ol className={cx('pb-timeline', className)}>
      {items.map((it, i) => (
        <li key={i} className={cx('pb-timeline__item', it.tone && it.tone !== 'default' && `pb-timeline__item--${it.tone}`)}>
          <span className="pb-timeline__dot" aria-hidden="true" />
          <span className="pb-timeline__time pb-mono">{it.time}</span>
          <span className="pb-timeline__text">{it.children}</span>
        </li>
      ))}
    </ol>
  );
}
