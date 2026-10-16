import React from 'react';
import './primitives.css';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
type Size = 'sm' | 'md';
type Shared = { tone?: Tone; size?: Size; children: React.ReactNode; className?: string };
export function StatusChip({ tone = 'neutral', size = 'md', children, className = '' }: Shared) {
  return <span className={`pb-chip pb-chip--${tone} pb-chip--${size} ${className}`.trim()}>{children}</span>;
}
export type FilterChipProps = Shared & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  selected: boolean;
};
export function FilterChip({ tone = 'neutral', size = 'md', selected, children, className = '', type = 'button', ...rest }: FilterChipProps) {
  return <button {...rest} type={type} aria-pressed={selected} className={`pb-chip pb-chip--filter pb-chip--${tone} pb-chip--${size} ${selected ? 'pb-chip--selected' : ''} ${className}`.trim()}>{children}</button>;
}
