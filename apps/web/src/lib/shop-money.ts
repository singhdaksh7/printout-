// Rupee <-> paise conversion for the pricing editor. Integer maths only; never floats for money.
export const MAX_PRICE_PAISE = 100_000; // ₹1,000.00 per sheet: a sanity ceiling, the server remains authoritative.

export type PriceParse = { ok: true; paise: number } | { ok: false; error: string };

export function parseRupeesToPaise(input: string): PriceParse {
  const v = input.trim().replace(/^₹\s*/, '');
  if (v === '') return { ok: false, error: 'Enter a price.' };
  if (!/^\d+(\.\d{0,2})?$/.test(v)) {
    return { ok: false, error: /^-/.test(v) ? 'Price cannot be negative.' : 'Use a number with at most 2 decimals, e.g. 2.50.' };
  }
  const [whole = '0', frac = ''] = v.split('.');
  const paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(paise)) return { ok: false, error: 'Price is too large.' };
  if (paise <= 0) return { ok: false, error: 'Price must be more than ₹0.' };
  if (paise > MAX_PRICE_PAISE) return { ok: false, error: 'Price is too large (max ₹1,000.00 per sheet).' };
  return { ok: true, paise };
}

export function paiseToRupeesInput(paise: number): string {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}
