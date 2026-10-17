// Poster model: templates, sizes, validated settings and the text/URL safety rules. Pure, no I/O.
// Brand colours are the agreed Printout Buddy palette; the logo mark lives in ./brand.ts so a newly
// approved identity is a one-file change.

export const COLORS = {
  orange: '#E8772E',
  navy: '#14213D',
  softOrange: '#FFF4EA',
  white: '#FFFFFF',
  /** Secondary text: navy-leaning grey, 8:1 against white. */
  muted: '#3D4863'
} as const;

export const TEMPLATES = ['classic', 'premium', 'minimal'] as const;
export type TemplateId = (typeof TEMPLATES)[number];
export const TEMPLATE_INFO: Record<TemplateId, { label: string; description: string }> = {
  classic: { label: 'Classic', description: 'White page, orange header, navy type, large QR.' },
  premium: { label: 'Premium', description: 'Navy header, orange call to action, white content.' },
  minimal: { label: 'Minimal', description: 'Plain white page with a centred QR.' }
};

export const PAPER_SIZES = ['A4', 'A5'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];
/** Portrait page size in PostScript points (1/72 in): ISO 216, 210x297 mm and 148x210 mm. */
export const PAPER_PT: Record<PaperSize, { w: number; h: number; marginMm: number }> = {
  A4: { w: 595.2756, h: 841.8898, marginMm: 12 },
  A5: { w: 419.5276, h: 595.2756, marginMm: 10 }
};
export const MM = 72 / 25.4;

export const DEFAULT_HEADLINE = 'Scan to upload documents';
export const HEADLINE_MAX = 40;

export interface PosterSettings {
  template: TemplateId;
  size: PaperSize;
  headline: string;
  showAddress: boolean;
  showContact: boolean;
  showUrl: boolean;
  showPrivacy: boolean;
}

export const DEFAULT_SETTINGS: PosterSettings = {
  template: 'classic',
  size: 'A4',
  headline: DEFAULT_HEADLINE,
  // Address and contact are opt-in so nothing the shop has not chosen is printed on a public wall.
  showAddress: false,
  showContact: false,
  showUrl: true,
  showPrivacy: true
};

/** Characters a standard PDF font (WinAnsi) can draw. Everything else is replaced rather than risking a failed export. */
const EXTRA_WINANSI = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);
function printable(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa1 && cp <= 0xff) || EXTRA_WINANSI.has(cp);
}

export interface Cleaned { text: string; replaced: number }

/** Normalise untrusted text for drawing: NFC, whitespace collapsed, control characters dropped, unprintable glyphs replaced with "?". */
export function cleanText(input: unknown, maxLen: number): Cleaned {
  const raw = typeof input === 'string' ? input.normalize('NFC') : '';
  let out = '';
  let replaced = 0;
  let space = false;
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xa0 || /\s/u.test(ch)) { space = out.length > 0; continue; }
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xfeff) continue;
    if (space) { out += ' '; space = false; }
    if (printable(cp)) out += ch; else { out += '?'; replaced++; }
    if (out.length >= maxLen) break;
  }
  return { text: out.trim(), replaced };
}

/** File-name stem: lowercase ASCII letters, digits and hyphens only. */
export function safeFilenamePart(slug: string): string {
  const s = String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return s || 'shop';
}
export const posterFilename = (slug: string, size: PaperSize, ext: 'pdf' | 'png') => `printout-buddy-poster-${safeFilenamePart(slug)}-${size.toLowerCase()}.${ext}`;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The only URL a poster may encode: the shop's public upload page, `<origin>/p/<slug>`, exactly as the API reports it.
 * Anything else (other paths, credentials, query, hash, non-http(s) scheme) is rejected, never repaired.
 */
export function validatePublicUrl(publicUrl: unknown, slug: unknown): string | null {
  if (typeof publicUrl !== 'string' || typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 60) return null;
  let u: URL;
  try { u = new URL(publicUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== `/p/${slug}`) return null;
  return `${u.origin}/p/${slug}`;
}

const isTemplate = (v: unknown): v is TemplateId => (TEMPLATES as readonly unknown[]).includes(v);
const isSize = (v: unknown): v is PaperSize => (PAPER_SIZES as readonly unknown[]).includes(v);

/** Accepts anything (e.g. parsed localStorage) and returns settings made only of validated fields. */
export function sanitizeSettings(raw: unknown): PosterSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const headline = cleanText(o.headline, HEADLINE_MAX).text;
  return {
    template: isTemplate(o.template) ? o.template : DEFAULT_SETTINGS.template,
    size: isSize(o.size) ? o.size : DEFAULT_SETTINGS.size,
    headline: headline || DEFAULT_HEADLINE,
    showAddress: bool(o.showAddress, DEFAULT_SETTINGS.showAddress),
    showContact: bool(o.showContact, DEFAULT_SETTINGS.showContact),
    showUrl: bool(o.showUrl, DEFAULT_SETTINGS.showUrl),
    showPrivacy: bool(o.showPrivacy, DEFAULT_SETTINGS.showPrivacy)
  };
}

const storageKey = (slug: string) => `pb.qr-poster.v1:${safeFilenamePart(slug)}`;
export function loadSettings(slug: string): PosterSettings {
  try { const raw = window.localStorage.getItem(storageKey(slug)); return raw ? sanitizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(slug: string, s: PosterSettings): void {
  try { window.localStorage.setItem(storageKey(slug), JSON.stringify(s)); } catch { /* storage unavailable: settings simply do not persist */ }
}
export function clearSettings(slug: string): void {
  try { window.localStorage.removeItem(storageKey(slug)); } catch { /* ignore */ }
}
