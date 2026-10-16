import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { Icon, ICON_NAMES } from '../icons/Icon';

const css = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8');
function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`token --${name} missing`);
  return m[1]!.toUpperCase();
}
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('design tokens (docs/design/1.pdf p2)', () => {
  it.each([
    ['pb-navy', '#14213D'], ['pb-orange', '#E8772E'], ['pb-orange-ink', '#B04E17'], ['pb-orange-soft', '#FCEBDD'], ['pb-paper', '#FBFBF8'],
    ['pb-n50', '#F6F7F9'], ['pb-n100', '#EDEFF3'], ['pb-n200', '#DADFE7'], ['pb-n300', '#B9C1CE'], ['pb-n500', '#6A7487'], ['pb-n700', '#3B4558'],
    ['pb-ok', '#1F7A4D'], ['pb-warn', '#9A6200'], ['pb-err', '#B42318'], ['pb-info', '#2456C9']
  ])('%s is exactly %s', (name, hex) => {
    expect(token(name)).toBe(hex);
  });

  it('matches the contrast table printed in the design system', () => {
    expect(contrast(token('pb-navy'), token('pb-paper'))).toBeGreaterThan(15.3);
    expect(contrast(token('pb-navy'), token('pb-orange'))).toBeGreaterThan(5.3);
    expect(contrast(token('pb-orange-ink'), token('pb-paper'))).toBeGreaterThan(5.0);
    expect(contrast(token('pb-n500'), '#FFFFFF')).toBeGreaterThan(4.6);
    expect(contrast('#FFFFFF', token('pb-err'))).toBeGreaterThan(6.5);
    // The design rule that orange is never used for text on white:
    expect(contrast(token('pb-orange'), '#FFFFFF')).toBeLessThan(3);
  });

  it('keeps every derived soft tint at WCAG AA (>= 4.5:1) for its text colour', () => {
    for (const k of ['ok', 'warn', 'err', 'info']) {
      expect(contrast(token(`pb-${k}`), token(`pb-${k}-soft`)), `${k} on ${k}-soft`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(token('pb-orange-ink'), token('pb-orange-soft'))).toBeGreaterThanOrEqual(4.5);
  });

  it('defines the documented radii, spacing and motion values', () => {
    expect(css).toMatch(/--pb-radius-sm:\s*6px/);
    expect(css).toMatch(/--pb-radius-md:\s*10px/);
    expect(css).toMatch(/--pb-radius-lg:\s*16px/);
    for (const [n, v] of [[1, 4], [2, 8], [3, 12], [4, 16], [5, 24], [6, 32], [7, 48]]) expect(css).toMatch(new RegExp(`--pb-space-${n}:\\s*${v}px`));
    expect(css).toMatch(/--pb-dur-fast:\s*150ms/);
    expect(css).toMatch(/--pb-dur-slow:\s*250ms/);
    expect(css).toMatch(/--pb-target:\s*44px/);
  });
});

describe('Icon', () => {
  it('is decorative by default and named when given a label', () => {
    const { container, rerender } = render(<Icon name="printer" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    rerender(<Icon name="printer" label="Printer" />);
    expect(screen.getByRole('img', { name: 'Printer' })).toBeInTheDocument();
  });

  it('renders geometry for every vendored icon', () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      expect(container.querySelectorAll('svg > *').length, name).toBeGreaterThan(0);
      unmount();
    }
  });
});
