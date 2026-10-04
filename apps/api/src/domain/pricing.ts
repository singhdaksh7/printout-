import { z } from 'zod';
import { AppError } from '../errors.js';

/** Largest order total we will price (fits a signed 32-bit INT column with headroom). */
export const MAX_TOTAL_PAISE = 2_000_000_000;

/** Hard cap on the number of ranges a customer may submit (before merging). */
export const MAX_PAGE_RANGES = 50;

const rangeSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive() }).strict();

export const pageSelectionSchema = z.union([
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('ranges'), ranges: z.array(rangeSchema).min(1).max(MAX_PAGE_RANGES) }).strict()
]);

export const printOptionsSchema = z
  .object({
    paperSize: z.literal('A4'),
    colourMode: z.enum(['bw', 'colour']),
    sides: z.enum(['single', 'duplex']),
    copies: z.number().int().min(1).max(1000),
    pageSelection: pageSelectionSchema
  })
  .strict();

export type PrintOptions = z.infer<typeof printOptionsSchema>;
export type PageRange = { from: number; to: number };
export type PricingRule = {
  paperSize: 'A4';
  colourMode: 'bw' | 'colour';
  sides: 'single' | 'duplex';
  pricePerSheetPaise: number;
  active?: boolean;
};

const invalidRange = (message: string) => new AppError(422, 'INVALID_PAGE_RANGE', message);

/**
 * Validates ranges against the document page count and returns them sorted, merged (overlapping and
 * adjacent ranges collapse) and therefore free of duplicate pages. Work is O(n log n) in the number of
 * ranges, never in the number of pages, so pathological input stays cheap.
 */
export function normaliseRanges(ranges: PageRange[], pageCount: number): PageRange[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw invalidRange('Document has no printable pages');
  if (ranges.length === 0 || ranges.length > MAX_PAGE_RANGES) throw invalidRange('Too many or no page ranges');
  for (const r of ranges) {
    if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 1 || r.to < r.from) {
      throw invalidRange('Page range is malformed');
    }
    if (r.to > pageCount) throw invalidRange(`Page range is out of bounds (document has ${pageCount} pages)`);
  }
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: PageRange[] = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else merged.push({ from: r.from, to: r.to });
  }
  return merged;
}

/** Parses "1-5,3-7,9" style input (convenience for tests/CLI); same guarantees as normaliseRanges. */
export function parsePageRanges(input: string, pageCount: number): PageRange[] {
  if (input.length === 0 || input.length > 1000) throw invalidRange('Invalid page selection');
  const ranges: PageRange[] = [];
  for (const part of input.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) throw invalidRange('Malformed page range');
    ranges.push({ from: Number(match[1]), to: Number(match[2] ?? match[1]) });
  }
  return normaliseRanges(ranges, pageCount);
}

/** Returns options whose page selection is validated against `pageCount` and normalised. */
export function normalisePrintOptions(options: PrintOptions, pageCount: number): PrintOptions {
  if (options.pageSelection.mode === 'all') return { ...options, pageSelection: { mode: 'all' } };
  return { ...options, pageSelection: { mode: 'ranges', ranges: normaliseRanges(options.pageSelection.ranges, pageCount) } };
}

export function selectedPages(options: PrintOptions, pageCount: number): number {
  if (options.pageSelection.mode === 'all') return pageCount;
  return normaliseRanges(options.pageSelection.ranges, pageCount).reduce((n, r) => n + r.to - r.from + 1, 0);
}

export function quote(options: PrintOptions, pageCount: number, rules: PricingRule[]) {
  const parsed = normalisePrintOptions(printOptionsSchema.parse(options), pageCount);
  const count = selectedPages(parsed, pageCount);
  const rule = rules.find(
    (r) => r.active !== false && r.paperSize === 'A4' && r.colourMode === parsed.colourMode && r.sides === parsed.sides
  );
  if (!rule) throw new AppError(422, 'NO_PRICING_RULE', 'No active pricing rule for the selected print options');
  const sheetsPerCopy = parsed.sides === 'duplex' ? Math.ceil(count / 2) : count;
  const totalSheets = sheetsPerCopy * parsed.copies;
  // Orders.totalPaise is a 32-bit INT: refuse (cleanly) anything that would overflow it.
  if (totalSheets * rule.pricePerSheetPaise > MAX_TOTAL_PAISE) {
    throw new AppError(422, 'VALIDATION_ERROR', 'The order total is too large. Reduce the number of copies or pages.');
  }
  return {
    printOptions: parsed,
    selectedPageCount: count,
    sheetsPerCopy,
    totalSheets,
    unitPricePaise: rule.pricePerSheetPaise,
    totalPaise: totalSheets * rule.pricePerSheetPaise,
    currency: 'INR' as const
  };
}
export type QuoteResult = ReturnType<typeof quote>;
