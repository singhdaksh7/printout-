import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';
import { Skeleton } from '../feedback/Skeleton';
import { useMediaQuery } from '../useMediaQuery';
import './data.css';

export interface Column<R> {
  key: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  align?: 'start' | 'center' | 'end';
  /** Hide the header text visually but keep it for assistive tech (e.g. an Action column). */
  srOnlyHeader?: boolean;
  className?: string;
}

export interface DataTableProps<R> {
  columns: ReadonlyArray<Column<R>>;
  rows: ReadonlyArray<R>;
  getRowKey: (row: R) => string;
  /** Accessible name of the table. */
  caption: string;
  /** Row that is open in a drawer; gets a blue-tinted highlight and aria-current. */
  selectedKey?: string | null;
  /** Rows to flash with the soft orange highlight for 4 s (newly arrived queue rows). */
  highlightKeys?: ReadonlySet<string> | ReadonlyArray<string>;
  /** Mouse/touch convenience for opening details. Keyboard users must still get a real button in the row. */
  onRowClick?: (row: R) => void;
  loading?: boolean;
  loadingRows?: number;
  /** Accessible text announced while loading (default "Loading"), e.g. "Loading orders". */
  loadingLabel?: string;
  /** Shown instead of the table when there are no rows (and not loading). Use EmptyState. */
  empty?: ReactNode;
  /** Below `cardsBelow` px each row is rendered with this instead of the table (one DOM, never both). */
  renderCard?: (row: R) => ReactNode;
  cardsBelow?: number;
  footer?: ReactNode;
  /** Extra attributes for each row (and each phone card): data-* hooks, ids. Do not use to override the table semantics. */
  rowAttributes?: (row: R) => HTMLAttributes<HTMLElement> & { [data: `data-${string}`]: string | undefined };
  className?: string;
}

/**
 * Responsive data table. Semantic table with a captioned, keyboard-scrollable region; optional card layout on
 * phones; skeleton rows while loading; empty slot. Sorting and filtering stay with the caller (server-owned data).
 */
export function DataTable<R>({ columns, rows, getRowKey, caption, selectedKey, highlightKeys, onRowClick, loading, loadingRows = 5, loadingLabel = 'Loading', empty, renderCard, cardsBelow = 768, footer, rowAttributes, className }: DataTableProps<R>) {
  const narrow = useMediaQuery(`(max-width: ${cardsBelow - 1}px)`);
  const highlighted = new Set(highlightKeys ?? []);

  if (!loading && rows.length === 0 && empty) return <div className={cx('pb-table-card', className)}>{empty}</div>;

  if (narrow && renderCard && !loading) {
    return (
      <div className={cx('pb-cardlist', className)} role="list" aria-label={caption}>
        {rows.map((r) => {
          const key = getRowKey(r);
          return (
            <div key={key} role="listitem" {...rowAttributes?.(r)} className={cx('pb-cardlist__item', key === selectedKey && 'is-selected', highlighted.has(key) && 'is-new')}>
              {renderCard(r)}
            </div>
          );
        })}
        {footer}
      </div>
    );
  }

  return (
    <div className={cx('pb-table-card', className)}>
      <div className="pb-table-scroll" role="region" aria-label={caption} tabIndex={0}>
        <table className="pb-table" aria-busy={loading || undefined}>
          <caption className="pb-sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cx(c.align && `is-${c.align}`, c.className)}>
                  {c.srOnlyHeader ? <span className="pb-sr-only">{c.header}</span> : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: loadingRows }, (_, i) => (
                  <tr key={i} aria-hidden="true">
                    {columns.map((c) => (
                      <td key={c.key} className={cx(c.align && `is-${c.align}`)}><Skeleton variant="block" width="70%" height={16} /></td>
                    ))}
                  </tr>
                ))
              : rows.map((r) => {
                  const key = getRowKey(r);
                  return (
                    <tr
                      key={key}
                      {...rowAttributes?.(r)}
                      className={cx(onRowClick && 'is-clickable', key === selectedKey && 'is-selected', highlighted.has(key) && 'is-new')}
                      aria-current={key === selectedKey ? 'true' : undefined}
                      onClick={onRowClick ? (e) => { if (!(e.target as HTMLElement).closest('a,button,input,select,textarea,label')) onRowClick(r); } : undefined}
                    >
                      {columns.map((c) => (
                        <td key={c.key} className={cx(c.align && `is-${c.align}`, c.className)}>{c.cell(r)}</td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      {loading && <span className="pb-sr-only" role="status">{loadingLabel}</span>}
      {footer && <div className="pb-table-footer">{footer}</div>}
    </div>
  );
}
