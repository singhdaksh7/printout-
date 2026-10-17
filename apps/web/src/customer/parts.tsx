import type { ReactNode } from 'react';
import { Banner } from '../ui';

export function NotFound({ title = 'Page not found', body = 'Check the link or scan the shop QR code again.' }: { title?: string; body?: string }) {
  return (
    <main className="cx-page"><div className="cx-card cx-center">
      <h1 className="cx-h1">{title}</h1>
      <p className="cx-muted">{body}</p>
    </div></main>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="cx-skel" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <span key={i} className="cx-skel-line" style={{ width: `${90 - i * 18}%` }} />)}
    </div>
  );
}

export function Alert({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' }) {
  return <Banner tone={tone === 'error' ? 'err' : 'info'}>{children}</Banner>;
}
