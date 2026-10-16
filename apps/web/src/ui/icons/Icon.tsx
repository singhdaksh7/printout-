import { createElement, type SVGProps } from 'react';
import { ICON_NODES, type IconName } from './nodes';

export type { IconName };
export const ICON_NAMES = Object.keys(ICON_NODES) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName;
  /** Pixel size (width and height). Default 20. */
  size?: number;
  /** Accessible name. Omit for decorative icons (they are hidden from assistive tech). */
  label?: string;
}

/** Inline SVG icon (Lucide geometry, ISC licence). Uses currentColor so it follows the text colour. */
export function Icon({ name, size = 20, label, strokeWidth = 2, className, ...rest }: IconProps) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const, focusable: false as const };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `pb-icon ${className}` : 'pb-icon'}
      {...a11y}
      {...rest}
    >
      {ICON_NODES[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
