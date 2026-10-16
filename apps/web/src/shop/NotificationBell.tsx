import { useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Banner, Button, Checkbox, EmptyState, Icon, IconButton, Drawer, Skeleton } from '../ui';
import { ageLabel, useTick } from './hooks';
import { useAlertSound } from './alert-sound';
import { useNotifications } from './notifications';
import { useRealtime } from './realtime';

const CONNECTION_COPY = {
  live: 'Connected: new orders appear instantly.',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting… new orders are picked up as soon as the connection returns.',
  offline: 'Temporarily disconnected. Your queue still works; new orders appear after you reconnect.'
} as const;

/** Moves focus between notification links with the arrow keys (list navigation); Tab still reaches every control. */
function onListKeyDown(e: KeyboardEvent<HTMLUListElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const links = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-notif-link]'));
  if (links.length === 0) return;
  const at = links.findIndex((l) => l === document.activeElement || l.parentElement?.contains(document.activeElement));
  let next = at;
  if (e.key === 'ArrowDown') next = Math.min(links.length - 1, at + 1);
  else if (e.key === 'ArrowUp') next = Math.max(0, at <= 0 ? 0 : at - 1);
  else if (e.key === 'Home') next = 0;
  else next = links.length - 1;
  e.preventDefault();
  links[next]?.focus();
}

/** Bell with unread badge in the top bar; opens the notification panel (a drawer: full screen on phones). */
export function NotificationBell() {
  const n = useNotifications();
  const { state: conn } = useRealtime();
  const sound = useAlertSound();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useTick(() => Math.floor(Date.now() / 60_000)); // refresh "x min ago" labels once a minute while open

  const close = () => { setOpen(false); btn.current?.focus(); };
  const label = n.unread > 0 ? `Notifications, ${n.unread} unread` : 'Notifications';

  return (
    <>
      <span className="pb-bell">
        <IconButton ref={btn} icon="bell" label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
        {n.unread > 0 && <Badge tone="orange" className="pb-bell__badge" aria-hidden="true">{n.unread > 99 ? '99+' : n.unread}</Badge>}
      </span>
      {open && (
        <Drawer title="Notifications" header={<span className="pb-notifpanel__title">Notifications</span>} onClose={close} className="pb-notifpanel">
          <div className="pb-notifpanel__tools">
            <Button variant="outline" size="sm" iconStart="check-check" onClick={() => void n.markAllRead()} disabled={n.unread === 0}>
              Mark all as read
            </Button>
            <Checkbox
              label="Sound for new orders"
              checked={sound.enabled}
              onChange={() => sound.set(!sound.enabled)}
            />
          </div>
          {sound.enabled && sound.blocked && (
            <Banner tone="warn" icon="volume-x" actions={<Button size="sm" variant="outline" onClick={() => void sound.test()}>Enable sound</Button>}>
              Your browser is blocking the sound. Click Enable sound once to allow it.
            </Banner>
          )}
          <p className={`pb-notifpanel__conn is-${conn}`} role="status">{CONNECTION_COPY[conn]}</p>
          {n.actionError && <Banner tone="warn">{n.actionError}</Banner>}

          {n.status === 'loading' && <Skeleton lines={3} label="Loading notifications" />}
          {n.status === 'error' && (
            <Banner tone="warn" title="Notifications are unavailable right now" actions={<Button size="sm" variant="outline" onClick={n.retry}>Retry</Button>}>
              {n.error ?? 'Your orders are not affected.'} Your queue and orders still work.
            </Banner>
          )}
          {n.status === 'ready' && n.items.length === 0 && (
            <EmptyState icon="bell" title="No notifications yet" titleAs="h3">
              New orders show up here the moment a customer sends one.
            </EmptyState>
          )}
          {n.items.length > 0 && (
            <ul className="pb-notiflist" role="list" aria-label="Recent notifications, newest first" onKeyDown={onListKeyDown}>
              {n.items.map((item) => (
                <li key={item.id} className={`pb-notif${item.readAt ? '' : ' is-unread'}`}>
                  <Link
                    to={`/shop/orders/${encodeURIComponent(item.data.orderId)}`}
                    className="pb-notif__link"
                    data-notif-link
                    onClick={() => { void n.markRead(item.id); close(); }}
                  >
                    <Icon name="file-text" size={18} className="pb-notif__icon" />
                    <span className="pb-notif__text">
                      <span className="pb-notif__title">
                        New order <strong>{item.data.orderNumber}</strong>
                        {!item.readAt && <span className="pb-sr-only"> (unread)</span>}
                      </span>
                      <time className="pb-notif__time" dateTime={item.createdAt}>{ageLabel(item.createdAt)}</time>
                    </span>
                  </Link>
                  {!item.readAt && (
                    <IconButton icon="check" size="sm" label={`Mark ${item.data.orderNumber} as read`} onClick={() => void n.markRead(item.id)} />
                  )}
                </li>
              ))}
            </ul>
          )}
          {n.hasMore && (
            <Button variant="outline" size="sm" onClick={n.loadMore} disabled={n.loadingMore}>
              {n.loadingMore ? 'Loading…' : 'Show older'}
            </Button>
          )}
        </Drawer>
      )}
    </>
  );
}
