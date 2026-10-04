import { parsePageRanges } from '../lib/customer-pages';
import type { PrintOptions } from '../lib/customer-api';

export type Config = { colourMode: 'bw' | 'colour'; sides: 'single' | 'duplex'; copies: string; pageMode: 'all' | 'custom'; pageText: string };
export const initialConfig: Config = { colourMode: 'bw', sides: 'single', copies: '1', pageMode: 'all', pageText: '' };
export const MAX_COPIES = 1000;

export function copiesError(copies: string): string | null {
  if (!/^\d+$/.test(copies.trim())) return 'Enter a whole number from 1 to 1000.';
  const n = Number(copies);
  return n < 1 || n > MAX_COPIES ? 'Copies must be between 1 and 1000.' : null;
}

export function buildOptions(cfg: Config, pageCount: number | null): { options: PrintOptions | null; copiesError: string | null; pagesError: string | null } {
  const ce = copiesError(cfg.copies);
  let pagesError: string | null = null;
  let pageSelection: PrintOptions['pageSelection'] = { mode: 'all' };
  if (cfg.pageMode === 'custom') {
    const r = parsePageRanges(cfg.pageText, pageCount);
    if (r.ok) pageSelection = { mode: 'ranges', ranges: r.ranges }; else pagesError = r.error;
  }
  if (ce || pagesError) return { options: null, copiesError: ce, pagesError };
  return { options: { paperSize: 'A4', colourMode: cfg.colourMode, sides: cfg.sides, copies: Number(cfg.copies), pageSelection }, copiesError: null, pagesError: null };
}

export function describeOptions(o: Partial<PrintOptions>): string[] {
  const out: string[] = ['A4'];
  if (o.colourMode) out.push(o.colourMode === 'colour' ? 'Colour' : 'Black & white');
  if (o.sides) out.push(o.sides === 'duplex' ? 'Double-sided' : 'Single-sided');
  if (o.copies) out.push(`${o.copies} ${o.copies === 1 ? 'copy' : 'copies'}`);
  if (o.pageSelection) {
    out.push(o.pageSelection.mode === 'all' ? 'All pages'
      : `Pages ${o.pageSelection.ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(', ')}`);
  }
  return out;
}
