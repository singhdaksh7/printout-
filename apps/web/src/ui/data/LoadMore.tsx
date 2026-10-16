import type { ReactNode } from 'react';
import { Button } from '../actions/Button';
import './data.css';

export interface LoadMoreProps {
  hasMore: boolean;
  /** A next page is being fetched. */
  loading?: boolean;
  onClick: () => void;
  /** Error element for a failed page fetch (usually a Banner with Retry). */
  error?: ReactNode;
  /** Shown when there is nothing more. Default "End of list". */
  endLabel?: string;
  /** Summary text, e.g. "Showing 9 of 173". */
  summary?: ReactNode;
}

/** Cursor pagination control: "Load more" while the API has a next cursor, otherwise an end marker. */
export function LoadMore({ hasMore, loading, onClick, error, endLabel = 'End of list', summary }: LoadMoreProps) {
  return (
    <div className="pb-loadmore">
      {error}
      {summary && <span className="pb-loadmore__summary">{summary}</span>}
      {hasMore ? (
        <Button variant="outline" size="sm" loading={!!loading} onClick={onClick}>{loading ? 'Loading…' : 'Load more'}</Button>
      ) : (
        <span className="pb-loadmore__end">{endLabel}</span>
      )}
    </div>
  );
}
