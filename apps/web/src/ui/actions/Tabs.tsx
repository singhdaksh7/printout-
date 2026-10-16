import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../cx';
import './actions.css';

export interface TabItem<T extends string> {
  key: T;
  label: ReactNode;
  /** Optional count shown after the label. */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  /** Accessible name of the tab list (e.g. "Order filters"). */
  label: string;
  tabs: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (key: T) => void;
  /** Stable id prefix. Tab ids are `${idPrefix}-tab-${key}`; point the panel's aria-labelledby at the active one. */
  idPrefix: string;
  /** id of the single panel the tabs control (the content that changes with the tab). */
  panelId?: string;
  className?: string;
}

/**
 * Filter tabs over one panel of content (WAI-ARIA tabs pattern, automatic activation): the selected tab is the only
 * Tab stop, Left/Right move and select, Home/End jump. Use SegmentedControl instead for a plain single-choice setting.
 */
export function Tabs<T extends string>({ label, tabs, value, onChange, idPrefix, panelId, className }: TabsProps<T>) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabled = tabs.filter((t) => !t.disabled);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, key: T) {
    const i = enabled.findIndex((t) => t.key === key);
    let next: TabItem<T> | undefined;
    if (e.key === 'ArrowRight') next = enabled[(i + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(i - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    refs.current.get(next.key)?.focus();
    onChange(next.key);
  }

  return (
    <div role="tablist" aria-label={label} className={cx('pb-seg', 'pb-tabs', className)}>
      {tabs.map((t) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            ref={(el) => { if (el) refs.current.set(t.key, el); else refs.current.delete(t.key); }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.key}`}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            className="pb-tab"
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKeyDown(e, t.key)}
          >
            {t.label}
            {t.count !== undefined && <span className="pb-seg__count pb-tnum">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
