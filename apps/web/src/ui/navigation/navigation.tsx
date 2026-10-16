import type { MouseEvent, ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cx } from '../cx';
import { Icon, type IconName } from '../icons/Icon';
import { Badge } from '../status/Badge';
import './navigation.css';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Match only this exact path (e.g. the queue at `/shop`). */
  end?: boolean;
  /** Count shown at the right (new jobs). Hidden when 0 unless `showZero`. */
  count?: number;
  showZero?: boolean;
  /** Plan tag such as "Pro". */
  tag?: string;
  /** Right-aligned status badge (e.g. a red "Due"). */
  alert?: string;
  /** Feature without a working backend yet: shown but not navigable, labelled "Coming soon". */
  comingSoon?: boolean;
}

function countLabel(item: NavItem) {
  return item.count === undefined ? undefined : `${item.count} ${item.count === 1 ? 'item' : 'items'}`;
}

export interface SidebarProps {
  /** Accessible name of the navigation landmark. */
  label: string;
  /** Brand block at the top: the approved logo lockup. */
  brand: ReactNode;
  items: ReadonlyArray<NavItem>;
  /** Plan or status card at the bottom (pilot progress, signed-in user). */
  footer?: ReactNode;
  /** Runs before navigation; call `preventDefault()` to cancel (unsaved-changes guard). */
  onNavigate?: (e: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
}

/** Navy sidebar (232px). Collapses to an icon rail on tablets; hidden on phones where BottomNav takes over. */
export function Sidebar({ label, brand, items, footer, onNavigate, className }: SidebarProps) {
  return (
    <aside className={cx('pb-sidebar', className)}>
      <div className="pb-sidebar__brand">{brand}</div>
      <nav aria-label={label} className="pb-sidebar__nav">
        <ul>
          {items.map((it) => (
            <li key={it.to}>
              {it.comingSoon ? (
                <span className="pb-nav pb-nav--soon" aria-disabled="true">
                  <Icon name={it.icon} size={20} />
                  <span className="pb-nav__text">{it.label}<span className="pb-sr-only"> (coming soon)</span></span>
                  <Badge onDark className="pb-nav__tag" aria-hidden="true">Soon</Badge>
                </span>
              ) : (
                <NavLink to={it.to} end={it.end} onClick={onNavigate} className={({ isActive }) => cx('pb-nav', isActive && 'is-active')} aria-label={it.count !== undefined && (it.count > 0 || it.showZero) ? `${it.label}, ${countLabel(it)}` : undefined}>
                  <Icon name={it.icon} size={20} />
                  <span className="pb-nav__text">{it.label}</span>
                  {it.tag && <Badge onDark className="pb-nav__tag">{it.tag}</Badge>}
                  {it.alert && <Badge tone="err" className="pb-nav__tag">{it.alert}</Badge>}
                  {it.count !== undefined && (it.count > 0 || it.showZero) && <Badge tone="orange" className="pb-nav__tag" aria-hidden="true">{it.count}</Badge>}
                </NavLink>
              )}
            </li>
          ))}
        </ul>
      </nav>
      {footer && <div className="pb-sidebar__footer">{footer}</div>}
    </aside>
  );
}

export interface BottomNavProps {
  label: string;
  /** Three to five destinations. The caller decides what goes under "More". */
  items: ReadonlyArray<NavItem>;
  onNavigate?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

/** Phone tab bar (Queue, History, Printers, More). Visible below 768px only. */
export function BottomNav({ label, items, onNavigate }: BottomNavProps) {
  return (
    <nav aria-label={label} className="pb-bottomnav">
      <ul>
        {items.filter((i) => !i.comingSoon).map((it) => (
          <li key={it.to}>
            <NavLink to={it.to} end={it.end} onClick={onNavigate} className={({ isActive }) => cx('pb-bottomnav__link', isActive && 'is-active')}>
              <span className="pb-bottomnav__icon">
                <Icon name={it.icon} size={22} />
                {it.count !== undefined && it.count > 0 && <Badge tone="orange" className="pb-bottomnav__badge" aria-label={`${it.count} new`}>{it.count}</Badge>}
              </span>
              <span>{it.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface TopBarProps {
  /** Left side: shop name and address, or environment pill. */
  start?: ReactNode;
  /** Middle: global search (admin). */
  center?: ReactNode;
  /** Right side: device pill, sound toggle, user menu. */
  end?: ReactNode;
  className?: string;
}

export function TopBar({ start, center, end, className }: TopBarProps) {
  return (
    <header className={cx('pb-topbar', className)}>
      {start && <div className="pb-topbar__start">{start}</div>}
      {center && <div className="pb-topbar__center">{center}</div>}
      {end && <div className="pb-topbar__end">{end}</div>}
    </header>
  );
}

export interface AppShellProps {
  sidebar: ReactNode;
  topbar: ReactNode;
  /** Phone tab bar, rendered after the main content. */
  bottomNav?: ReactNode;
  /** Banners that span the whole width above the top bar (e.g. sticky payment-failed notice). */
  notice?: ReactNode;
  children: ReactNode;
}

/** 232px sidebar + content (max 1200px, 24px gutters; 16px on phones). Includes a skip link to the main region. */
export function AppShell({ sidebar, topbar, bottomNav, notice, children }: AppShellProps) {
  return (
    <div className="pb-theme pb-shell">
      <a className="pb-skip" href="#pb-main">Skip to main content</a>
      {sidebar}
      <div className="pb-shell__col">
        {notice}
        {topbar}
        <main id="pb-main" className="pb-shell__main" tabIndex={-1}>
          <div className="pb-shell__content">{children}</div>
        </main>
      </div>
      {bottomNav}
    </div>
  );
}
