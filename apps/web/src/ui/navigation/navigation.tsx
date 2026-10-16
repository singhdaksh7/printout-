import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { matchPath, NavLink, useLocation } from 'react-router-dom';
import { IconButton } from '../actions/IconButton';
import { cx } from '../cx';
import { Icon, type IconName } from '../icons/Icon';
import { useFocusTrap } from '../overlays/useFocusTrap';
import { Badge } from '../status/Badge';
import './navigation.css';

export interface NavItem {
  to: string;
  label: string;
  /** Shorter label for the phone tab bar, where six tabs share 360px. Falls back to `label`. */
  shortLabel?: string;
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

function countNoun(count: number) {
  return count === 1 ? 'item' : 'items';
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
                <NavLink to={it.to} end={it.end} onClick={onNavigate} className={({ isActive }) => cx('pb-nav', isActive && 'is-active')}>
                  <Icon name={it.icon} size={20} />
                  <span className="pb-nav__text">{it.label}</span>
                  {it.tag && <Badge onDark className="pb-nav__tag">{it.tag}</Badge>}
                  {it.alert && <Badge tone="err" className="pb-nav__tag">{it.alert}</Badge>}
                  {/* The accessible name is built from content, so it always contains the visible text (WCAG 2.5.3). */}
                  {it.count !== undefined && (it.count > 0 || it.showZero) && <Badge tone="orange" className="pb-nav__tag">{it.count}<span className="pb-sr-only"> {countNoun(it.count)}</span></Badge>}
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
  /** Up to five destinations that stay visible. */
  items: ReadonlyArray<NavItem>;
  /** Everything else. Shown in a "More" sheet so no destination is unreachable on a phone. Omit when nothing is left over. */
  moreItems?: ReadonlyArray<NavItem>;
  onNavigate?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

/** Phone tab bar (visible below 768px only): the main destinations plus a "More" button that opens a sheet with the rest. */
export function BottomNav({ label, items, moreItems = [], onNavigate }: BottomNavProps) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const more = moreItems.filter((i) => !i.comingSoon);
  const moreActive = more.some((i) => matchPath({ path: i.to, end: i.end ?? false }, pathname));
  useEffect(() => setOpen(false), [pathname]);
  return (
    <>
      <nav aria-label={label} className="pb-bottomnav">
        <ul>
          {items.filter((i) => !i.comingSoon).map((it) => (
            <li key={it.to}>
              <NavLink to={it.to} end={it.end} onClick={onNavigate} className={({ isActive }) => cx('pb-bottomnav__link', isActive && 'is-active')}>
                <span className="pb-bottomnav__icon">
                  <Icon name={it.icon} size={22} />
                  {it.count !== undefined && it.count > 0 && <Badge tone="orange" className="pb-bottomnav__badge" aria-label={`${it.count} new`}>{it.count}</Badge>}
                </span>
                <span>{it.shortLabel ?? it.label}</span>
              </NavLink>
            </li>
          ))}
          {more.length > 0 && (
            <li>
              <button type="button" className={cx('pb-bottomnav__link', (moreActive || open) && 'is-active')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
                <span className="pb-bottomnav__icon"><Icon name="ellipsis" size={22} /></span>
                <span>More</span>
              </button>
            </li>
          )}
        </ul>
      </nav>
      {open && <MoreSheet label={label} items={more} onClose={() => setOpen(false)} onNavigate={onNavigate} />}
    </>
  );
}

function MoreSheet({ label, items, onClose, onNavigate }: { label: string; items: ReadonlyArray<NavItem>; onClose: () => void; onNavigate?: ((e: MouseEvent<HTMLAnchorElement>) => void) | undefined }) {
  const { ref, onKeyDown } = useFocusTrap<HTMLDivElement>({ onEscape: onClose });
  return (
    <div className="pb-sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="pb-sheet" role="dialog" aria-modal="true" aria-label="More" onKeyDown={onKeyDown} tabIndex={-1}>
        <div className="pb-sheet__header">
          <h2 className="pb-sheet__title">More</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <nav aria-label={`${label}, more`}>
          <ul className="pb-sheet__list">
            {items.map((it) => (
              <li key={it.to}>
                <NavLink to={it.to} end={it.end} onClick={(e) => { onNavigate?.(e); if (!e.defaultPrevented) onClose(); }} className={({ isActive }) => cx('pb-sheet__link', isActive && 'is-active')}>
                  <Icon name={it.icon} size={22} />
                  <span>{it.label}</span>
                  <Icon name="chevron-right" size={18} className="pb-sheet__chev" />
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}

export interface BrandLogoProps {
  /** Second line under the name, e.g. "Platform admin". */
  sub?: string;
  /** For the navy sidebar. */
  onDark?: boolean;
  className?: string;
}

/** The product lockup: orange brand tile with the printer mark, then the PrintoutBuddy wordmark (Rubik 700). */
export function BrandLogo({ sub, onDark, className }: BrandLogoProps) {
  return (
    <span className={cx('pb-brand', onDark && 'pb-brand--on-dark', className)}>
      <span className="pb-brand__tile" aria-hidden="true"><Icon name="printer" size={20} /></span>
      <span className="pb-brand__text">
        <span className="pb-brand__name">PrintoutBuddy</span>
        {sub && <span className="pb-brand__sub">{sub}</span>}
      </span>
    </span>
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
