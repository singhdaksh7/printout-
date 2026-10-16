import type { ReactNode } from 'react';
import './feedback.css';

export interface ToastRegionProps {
  /** Current message; `null`/empty hides the toast. The region itself stays mounted so screen readers announce changes. */
  message: ReactNode | null;
}

/** Fixed, polite live region that shows one navy toast (e.g. "New job 4823 · Project_report.docx"). */
export function ToastRegion({ message }: ToastRegionProps) {
  return (
    <div className="pb-toast-region" aria-live="polite" role="status">
      {message ? <div className="pb-toast">{message}</div> : null}
    </div>
  );
}
