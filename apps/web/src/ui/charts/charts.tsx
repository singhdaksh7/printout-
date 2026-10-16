import type { ReactNode } from 'react';
import { cx } from '../cx';
import './charts.css';

/* Hand-built SVG/CSS charts (no chart dependency). Every chart has a text alternative:
   BarChart a visually hidden data table, HBarList real list text, HeartbeatStrip/SegmentedBar a summary label. */

export interface BarDatum {
  label: string;
  value: number;
  /** `highlight` is the single orange bar (the peak); `muted` marks a partial/in-progress bucket. */
  tone?: 'default' | 'highlight' | 'muted';
}

export interface BarChartProps {
  data: ReadonlyArray<BarDatum>;
  /** Short description announced for the chart, e.g. "Jobs per hour, today". */
  title: string;
  /** Text alternative summary, e.g. "Busiest at 4 pm with 7 jobs". */
  summary?: string;
  yMax?: number;
  /** Axis tick values. Default: 0, half, max. */
  yTicks?: ReadonlyArray<number>;
  valueLabels?: boolean;
  yAxisLabel?: string;
  height?: number;
  /** Column header names for the hidden data table. */
  valueName?: string;
  /** Show every Nth x label (dense charts such as 30 days). Default 1. */
  labelEvery?: number;
  className?: string;
}

const W = 640;
const PAD = { top: 22, right: 8, bottom: 26, left: 34 };

export function BarChart({ data, title, summary, yMax, yTicks, valueLabels = true, yAxisLabel, height = 220, valueName = 'Value', labelEvery = 1, className }: BarChartProps) {
  const max = Math.max(1, yMax ?? Math.max(...data.map((d) => d.value), 1));
  const ticks = yTicks ?? [0, Math.round(max / 2), max];
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const slot = data.length ? innerW / data.length : innerW;
  const barW = Math.min(36, slot * 0.62);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  return (
    <figure className={cx('pb-chart', className)}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={summary ? `${title}. ${summary}` : title} className="pb-chart__svg" preserveAspectRatio="xMidYMid meet">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="pb-chart__grid" />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="pb-chart__tick">{t}</text>
          </g>
        ))}
        {yAxisLabel && <text transform={`translate(10 ${PAD.top + innerH / 2}) rotate(-90)`} textAnchor="middle" className="pb-chart__tick">{yAxisLabel}</text>}
        {data.map((d, i) => {
          const x = PAD.left + slot * i + (slot - barW) / 2;
          const h = Math.max(0, (d.value / max) * innerH);
          return (
            <g key={`${d.label}-${i}`}>
              <rect x={x} y={y(d.value)} width={barW} height={h} rx={3} className={cx('pb-chart__bar', d.tone && d.tone !== 'default' && `pb-chart__bar--${d.tone}`)} />
              {valueLabels && d.value > 0 && <text x={x + barW / 2} y={y(d.value) - 5} textAnchor="middle" className="pb-chart__value">{d.value}</text>}
              {i % labelEvery === 0 && <text x={x + barW / 2} y={height - 8} textAnchor="middle" className="pb-chart__tick">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      <table className="pb-sr-only">
        <caption>{title}</caption>
        <thead><tr><th scope="col">Label</th><th scope="col">{valueName}</th></tr></thead>
        <tbody>{data.map((d, i) => <tr key={i}><th scope="row">{d.label}</th><td>{d.value}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

export interface HBarDatum {
  label: string;
  value: number;
  valueLabel?: string;
}

export interface HBarListProps {
  items: ReadonlyArray<HBarDatum>;
  /** Max for the bar scale. Default: largest value. */
  max?: number;
  /** Accessible name of the list. */
  label: string;
  className?: string;
}

/** Horizontal bars with the value at the right (pages per day). Real list text, so no extra alternative is needed. */
export function HBarList({ items, max, label, className }: HBarListProps) {
  const m = Math.max(1, max ?? Math.max(...items.map((i) => i.value), 1));
  return (
    <ul className={cx('pb-hbars', className)} aria-label={label}>
      {items.map((it) => (
        <li key={it.label} className="pb-hbars__row">
          <span className="pb-hbars__label">{it.label}</span>
          <span className="pb-hbars__track" aria-hidden="true"><span className="pb-hbars__fill" style={{ width: `${(it.value / m) * 100}%` }} /></span>
          <span className="pb-hbars__value pb-tnum">{it.valueLabel ?? it.value}</span>
        </li>
      ))}
    </ul>
  );
}

export type HeartbeatState = 'online' | 'degraded' | 'off-hours' | 'offline';

export interface HeartbeatStripProps {
  blocks: ReadonlyArray<HeartbeatState>;
  /** Short summary for assistive tech, e.g. "Online 62 of 96 blocks; offline since 17:53". */
  summary: string;
  /** Time labels under the strip (start .. end). */
  axis?: ReadonlyArray<string>;
  className?: string;
}

const HB_LABEL: Record<HeartbeatState, string> = { online: 'online', degraded: 'degraded (printer error)', 'off-hours': 'off outside shop hours', offline: 'offline in shop hours' };

/** Agent presence over time, one block per interval, with a legend. Colours are paired with the text legend. */
export function HeartbeatStrip({ blocks, summary, axis, className }: HeartbeatStripProps) {
  return (
    <div className={cx('pb-heartbeat', className)}>
      <div className="pb-heartbeat__strip" role="img" aria-label={summary}>
        {blocks.map((b, i) => <span key={i} className={`pb-heartbeat__block pb-heartbeat__block--${b}`} />)}
      </div>
      {axis && <div className="pb-heartbeat__axis" aria-hidden="true">{axis.map((a) => <span key={a} className="pb-mono">{a}</span>)}</div>}
      <ul className="pb-legend">
        {(Object.keys(HB_LABEL) as HeartbeatState[]).map((k) => (
          <li key={k}><span className={`pb-legend__swatch pb-heartbeat__block--${k}`} aria-hidden="true" />{HB_LABEL[k]}</li>
        ))}
      </ul>
    </div>
  );
}

export interface Segment {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'err' | 'neutral';
}

export interface SegmentedBarProps {
  segments: ReadonlyArray<Segment>;
  summary: string;
  caption?: ReactNode;
  className?: string;
}

/** One proportional bar split into labelled segments (version distribution). */
export function SegmentedBar({ segments, summary, caption, className }: SegmentedBarProps) {
  const total = Math.max(1, segments.reduce((n, s) => n + s.value, 0));
  return (
    <div className={cx('pb-segbar', className)}>
      <div className="pb-segbar__bar" role="img" aria-label={summary}>
        {segments.filter((s) => s.value > 0).map((s) => (
          <span key={s.label} className={`pb-segbar__seg pb-segbar__seg--${s.tone ?? 'neutral'}`} style={{ flexGrow: s.value }}>{s.label} · {s.value}</span>
        ))}
      </div>
      {caption && <p className="pb-segbar__caption">{caption}</p>}
      <span className="pb-sr-only">{Math.round(total)} total</span>
    </div>
  );
}
