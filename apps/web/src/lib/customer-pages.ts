// Client-side page range parsing. ONLY used to build the pageSelection payload and give instant feedback;
// the server remains authoritative (INVALID_PAGE_RANGE is displayed when it disagrees).
export type PageRange = { from: number; to: number };
export type PageParse = { ok: true; ranges: PageRange[] } | { ok: false; error: string };

export const MAX_PAGE_INPUT_LENGTH = 200;
export const MAX_RANGE_COUNT = 50;

export function parsePageRanges(input: string, pageCount: number | null): PageParse {
  const text = input.replace(/\s+/g, '');
  if (!text) return { ok: false, error: 'Enter the pages to print, like 1-5, 8, 10-12.' };
  if (text.length > MAX_PAGE_INPUT_LENGTH) return { ok: false, error: 'That page list is too long. Use fewer ranges.' };
  if (!/^[0-9,-]+$/.test(text)) return { ok: false, error: 'Use only numbers, commas and dashes, like 1-5, 8, 10-12.' };
  const parts = text.split(',');
  if (parts.length > MAX_RANGE_COUNT) return { ok: false, error: `Use at most ${MAX_RANGE_COUNT} ranges.` };
  const ranges: PageRange[] = [];
  for (const part of parts) {
    const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(part);
    if (!m) return { ok: false, error: 'Check the format. Example: 1-5, 8, 10-12.' };
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < 1) return { ok: false, error: 'Page numbers start at 1.' };
    if (to < from) return { ok: false, error: `"${part}" is backwards. Write it as ${to}-${from}.` };
    if (pageCount !== null && to > pageCount) {
      return { ok: false, error: `Your document has ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}. "${part}" is out of range.` };
    }
    ranges.push({ from, to });
  }
  return { ok: true, ranges };
}
