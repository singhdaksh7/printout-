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

export interface BrandMarkProps {
  /** "simple" drops the smile and uses three larger pixels; the approved set uses it at 48 px and below. */
  variant?: 'full' | 'simple';
  /** "orange" is the primary tile; "navy" is for backgrounds that are orange or busy. */
  tile?: 'orange' | 'navy';
  size?: number;
  /** Set when the mark stands alone (collapsed nav, favicon-like uses); otherwise it is decorative. */
  title?: string;
  className?: string;
}

const MARK_PIXELS: ReadonlyArray<readonly [number, number, number]> = [
  [32.1, 72, 1], [41.6, 72, 1], [51.1, 72, 0.55], [60.6, 72, 0.4], [36.9, 82.4, 0.5], [55.9, 82.4, 0.4]
];

/** The approved Buddy printer mark (docs/design/1.pdf): paper on top, a face on the printer body, pixels fading out below. */
export function BrandMark({ variant = 'full', tile = 'orange', size = 36, title, className }: BrandMarkProps) {
  const navy = tile === 'navy';
  const tileFill = navy ? 'var(--pb-navy)' : 'var(--pb-orange)';
  const body = navy ? 'var(--pb-orange)' : 'var(--pb-navy)';
  const light = 'var(--pb-paper)';
  const face = navy ? 'var(--pb-navy)' : light;
  return (
    <svg
      className={cx('pb-brandmark-svg', className)} width={size} height={size} viewBox="0 0 100 100" focusable="false"
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}
    >
      <rect width="100" height="100" rx="23" fill={tileFill} />
      {variant === 'simple' ? (
        <>
          <rect x="30" y="12" width="40" height="15" rx="4.5" fill={light} />
          <rect x="12" y="31" width="76" height="40" rx="16" fill={body} />
          <circle cx="36" cy="51" r="6.5" fill={face} /><circle cx="64" cy="51" r="6.5" fill={face} />
          {[24, 42.5, 61].map((x) => <rect key={x} x={x} y="77" width="14.5" height="12" rx="3" fill={light} />)}
        </>
      ) : (
        <>
          <rect x="32.1" y="11.9" width="36" height="14" rx="4" fill={light} />
          <rect x="16" y="29" width="68" height="38" rx="15" fill={body} />
          <circle cx="39" cy="44" r="4.6" fill={face} /><circle cx="61" cy="44" r="4.6" fill={face} />
          <path d="M42.3 53.6Q50 61.5 57.7 53.6" fill="none" stroke={face} strokeWidth="4" strokeLinecap="round" />
          {MARK_PIXELS.map(([x, y, o]) => <rect key={`${x}-${y}`} x={x} y={y} width="7.3" height="7.3" rx="1.7" fill={light} fillOpacity={o} />)}
        </>
      )}
    </svg>
  );
}

export interface BrandLogoProps {
  /** Second line under the name, e.g. "Platform admin". */
  sub?: string;
  /** For the navy sidebar. */
  onDark?: boolean;
  /** Mark only, for collapsed navigation and tight spaces. */
  compact?: boolean;
  className?: string;
}

/** The product lockup: the Buddy printer mark, then the PrintoutBuddy wordmark (Rubik 700, "Buddy" in orange). */
export function BrandLogo({ sub, onDark, compact, className }: BrandLogoProps) {
  if (compact) return <span className={cx('pb-brand', className)}><BrandMark size={32} variant="simple" title="PrintoutBuddy" /></span>;
  return (
    <span className={cx('pb-brand', onDark && 'pb-brand--on-dark', className)}>
      <BrandMark size={36} />
      <span className="pb-brand__text">
        <span className="pb-brand__name" role="img" aria-label="PrintoutBuddy">
          <span aria-hidden="true">Printout<span className="pb-brand__accent">Buddy</span></span>
        </span>
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
