// Poster layout: turns validated input into a flat list of drawing operations in page points, origin top-left.
// The PDF writer, the PNG writer and the on-screen preview all render this one list, so what the shopkeeper
// sees is what prints. Text is measured with Helvetica metrics (see ./fonts.ts) so wrapping is identical everywhere.
import QRCode from 'qrcode';
import { retentionPhrase } from '../../lib/retention';
import { BRAND } from './brand';
import { COLORS, MM, PAPER_PT, cleanText, validatePublicUrl, type PosterSettings } from './model';

export interface Measure { width(text: string, size: number, bold: boolean): number }

export type Op =
  | { k: 'rect'; x: number; y: number; w: number; h: number; r: number; fill?: string; stroke?: string; strokeW?: number }
  | { k: 'path'; d: string; x: number; y: number; scale: number; fill: string }
  | { k: 'text'; text: string; x: number; y: number; size: number; bold: boolean; color: string; align: 'left' | 'center' }
  | { k: 'qr'; x: number; y: number; cell: number; n: number; bits: Uint8Array; color: string };

export interface PosterInput {
  shopName: string;
  slug: string;
  publicUrl: string;
  address?: string | null;
  contact?: string | null;
  retentionMinutes?: number | null;
  settings: PosterSettings;
}

export interface Poster {
  width: number;
  height: number;
  /** Physical margin kept clear of content, points. */
  margin: number;
  ops: Op[];
  /** The encoded text, exactly. */
  qrText: string;
  /** Quiet-zone box (white square the QR sits in) and module pitch, points. */
  qrBox: { x: number; y: number; size: number; cell: number; n: number };
  /** Number of characters that could not be drawn and were replaced with "?". */
  replaced: number;
}

export const LINE_HEIGHT = 1.18;
export const ASCENT = 0.8;
export const QUIET_MODULES = 4;

function wrap(text: string, size: number, bold: boolean, maxW: number, m: Measure): string[] {
  const lines: string[] = [];
  let cur = '';
  const push = () => { if (cur) lines.push(cur); cur = ''; };
  for (const word of text.split(' ')) {
    if (!word) continue;
    const trial = cur ? `${cur} ${word}` : word;
    if (m.width(trial, size, bold) <= maxW) { cur = trial; continue; }
    push();
    if (m.width(word, size, bold) <= maxW) { cur = word; continue; }
    // A single token wider than the box (long URL, long word): break between characters.
    for (const ch of word) {
      if (cur && m.width(cur + ch, size, bold) > maxW) push();
      cur += ch;
    }
  }
  push();
  return lines;
}

interface Fitted { size: number; lines: string[] }
function fit(text: string, max: number, min: number, bold: boolean, maxW: number, maxLines: number, m: Measure): Fitted {
  for (let s = max; s >= min - 0.001; s -= 1) {
    const lines = wrap(text, s, bold, maxW, m);
    if (lines.length <= maxLines) return { size: s, lines };
  }
  const lines = wrap(text, min, bold, maxW, m).slice(0, maxLines);
  let last = lines[lines.length - 1] ?? '';
  while (last && m.width(`${last}...`, min, bold) > maxW) last = last.slice(0, -1);
  lines[lines.length - 1] = `${last.trimEnd()}...`;
  return { size: min, lines };
}

export function buildPoster(input: PosterInput, measure: Measure): Poster {
  const url = validatePublicUrl(input.publicUrl, input.slug);
  if (!url) throw new Error('Poster URL must be the shop public page (/p/<slug>)');
  const s = input.settings;
  const page = PAPER_PT[s.size];
  const W = page.w, H = page.h;
  const k = W / PAPER_PT.A4.w;
  const m = page.marginMm * MM;
  const cw = W - 2 * m;
  const mid = W / 2;
  const ops: Op[] = [];
  let replaced = 0;
  const clean = (v: unknown, max: number) => { const c = cleanText(v, max); replaced += c.replaced; return c.text; };

  const shopName = clean(input.shopName, 120) || 'Your print shop';
  const headline = clean(s.headline, 40) || 'Scan to upload documents';
  const address = s.showAddress ? clean(input.address, 300) : '';
  const contact = s.showContact ? clean(input.contact, 100) : '';

  const qr = QRCode.create(url, { errorCorrectionLevel: 'Q' });
  const n = qr.modules.size;
  const bits = Uint8Array.from(qr.modules.data as ArrayLike<number>);

  const text = (t: string, x: number, y: number, size: number, bold: boolean, color: string, align: 'left' | 'center' = 'left') => ops.push({ k: 'text', text: t, x, y, size, bold, color, align });
  const lines = (ls: string[], x: number, top: number, size: number, bold: boolean, color: string, align: 'left' | 'center') => {
    ls.forEach((l, i) => text(l, x, top + size * ASCENT + i * size * LINE_HEIGHT, size, bold, color, align));
    return ls.length * size * LINE_HEIGHT;
  };
  const brand = (anchorX: number, top: number, h: number, tile: string, glyph: string, color: string, align: 'left' | 'center') => {
    const size = h * 0.62;
    const tw = measure.width(BRAND.name, size, true);
    const gap = h * 0.3;
    const total = h + gap + tw;
    const x0 = align === 'center' ? anchorX - total / 2 : anchorX;
    ops.push({ k: 'rect', x: x0, y: top, w: h, h, r: h * 0.24, fill: tile });
    const g = h * 0.62;
    ops.push({ k: 'path', d: BRAND.glyphPath, x: x0 + (h - g) / 2, y: top + (h - g) / 2, scale: g / BRAND.glyphViewBox, fill: glyph });
    text(BRAND.name, x0 + h + gap, top + h / 2 + size * 0.35, size, true, color);
  };

  // ---- footer (bottom anchored): address, contact, privacy -------------------------------------------------
  interface FootLine { ls: string[]; size: number; bold: boolean; color: string }
  const premium = s.template === 'premium';
  const footPad = premium ? 16 * k : 0;
  const fw = cw - 2 * footPad - (premium ? 12 * k : 0);
  const foot: FootLine[] = [];
  if (address) foot.push({ ls: wrap(address, 12 * k, false, fw, measure).slice(0, 3), size: 12 * k, bold: false, color: COLORS.navy });
  if (contact) foot.push({ ls: wrap(contact, 12 * k, true, fw, measure).slice(0, 2), size: 12 * k, bold: true, color: COLORS.navy });
  if (s.showPrivacy) {
    foot.push({ ls: wrap(`Your documents are deleted automatically ${retentionPhrase(input.retentionMinutes)} after printing.`, 10.5 * k, false, fw, measure).slice(0, 2), size: 10.5 * k, bold: false, color: COLORS.muted });
  }
  const footGap = 4 * k;
  const footTextH = foot.reduce((a, f) => a + f.ls.length * f.size * LINE_HEIGHT, 0) + Math.max(0, foot.length - 1) * footGap;
  const footH = foot.length ? footTextH + (premium ? 2 * footPad : 12 * k) : 0;
  const footTop = H - m - footH;

  // ---- header -----------------------------------------------------------------------------------------------
  let y = m;
  if (s.template === 'minimal') {
    brand(mid, y, 26 * k, COLORS.orange, COLORS.navy, COLORS.navy, 'center');
    y += 26 * k + 26 * k;
    const f = fit(shopName, 34 * k, 20 * k, true, cw, 2, measure);
    y += lines(f.lines, mid, y, f.size, true, COLORS.navy, 'center');
    y += 10 * k;
    ops.push({ k: 'rect', x: mid - 28 * k, y, w: 56 * k, h: 3 * k, r: 1.5 * k, fill: COLORS.orange });
    y += 3 * k + 22 * k;
  } else {
    const bg = premium ? COLORS.navy : COLORS.orange;
    const fg = premium ? COLORS.white : COLORS.navy;
    const pad = 22 * k;
    const f = fit(shopName, 44 * k, 24 * k, true, cw - 2 * pad, 3, measure);
    const nameH = f.lines.length * f.size * LINE_HEIGHT;
    const hh = pad * 0.9 + 30 * k + 18 * k + nameH + pad;
    ops.push({ k: 'rect', x: m, y, w: cw, h: hh, r: 16 * k, fill: bg });
    brand(m + pad, y + pad * 0.9, 30 * k, premium ? COLORS.orange : COLORS.navy, premium ? COLORS.navy : COLORS.orange, fg, 'left');
    lines(f.lines, m + pad, y + pad * 0.9 + 30 * k + 18 * k, f.size, true, fg, 'left');
    y += hh + 26 * k;
  }

  // ---- call to action ---------------------------------------------------------------------------------------
  if (premium) {
    const f = fit(headline.toUpperCase(), 26 * k, 16 * k, true, cw - 40 * k, 2, measure);
    const th = f.lines.length * f.size * LINE_HEIGHT;
    const ph = th + 28 * k;
    ops.push({ k: 'rect', x: m, y, w: cw, h: ph, r: ph > 60 * k ? 20 * k : ph / 2, fill: COLORS.orange });
    lines(f.lines, mid, y + 14 * k, f.size, true, COLORS.navy, 'center');
    y += ph + 10 * k;
  } else {
    const f = fit(headline, s.template === 'minimal' ? 34 * k : 38 * k, 22 * k, true, cw, 2, measure);
    y += lines(f.lines, mid, y, f.size, true, COLORS.navy, 'center') + 4 * k;
  }
  y += lines(wrap('Point your phone camera at the code. No app needed.', 14 * k, false, cw, measure).slice(0, 2), mid, y, 14 * k, false, COLORS.muted, 'center');

  // ---- body: QR (+ steps, URL) ------------------------------------------------------------------------------
  const showSteps = s.template !== 'minimal';
  const stepsH = showSteps ? 30 * k : 0;
  const urlFit = s.showUrl ? fit(url, 14 * k, 9 * k, true, cw, 2, measure) : null;
  const urlH = urlFit ? urlFit.lines.length * urlFit.size * LINE_HEIGHT : 0;
  const panelPad = s.template === 'minimal' ? 0 : 14 * k;
  const gaps = (showSteps ? 1 : 0) + (urlFit ? 1 : 0);
  const minGap = 14 * k;
  const bodyTop = y + 8 * k;
  const bodyBottom = footH ? footTop - 14 * k : H - m;
  const fixed = stepsH + urlH + 2 * panelPad + gaps * minGap;
  const maxQr = Math.min((s.template === 'minimal' ? 380 : 310) * k, cw - 2 * panelPad);
  const qrSize = Math.max(0, Math.min(maxQr, bodyBottom - bodyTop - fixed));
  const cell = qrSize / (n + 2 * QUIET_MODULES);
  const extra = Math.min(30 * k, Math.max(0, (bodyBottom - bodyTop - fixed - qrSize) / (gaps + 1)));
  const gap = minGap + extra;

  let by = bodyTop + extra;
  const panelSize = qrSize + 2 * panelPad;
  const px = mid - panelSize / 2;
  if (s.template === 'classic') ops.push({ k: 'rect', x: px, y: by, w: panelSize, h: panelSize, r: 18 * k, fill: COLORS.softOrange });
  if (premium) ops.push({ k: 'rect', x: px, y: by, w: panelSize, h: panelSize, r: 18 * k, fill: COLORS.white, stroke: COLORS.navy, strokeW: 2.5 * k });
  const qx = px + panelPad, qy = by + panelPad;
  // The white square below includes the 4-module quiet zone; nothing decorative is ever drawn inside it.
  ops.push({ k: 'rect', x: qx, y: qy, w: qrSize, h: qrSize, r: 0, fill: COLORS.white });
  ops.push({ k: 'qr', x: qx + QUIET_MODULES * cell, y: qy + QUIET_MODULES * cell, cell, n, bits, color: COLORS.navy });
  by += panelSize + gap;

  if (showSteps) {
    const labels = ['Scan the code', 'Upload your file', 'Collect your prints'];
    const colW = cw / 3;
    labels.forEach((label, i) => {
      const f = fit(label, 12.5 * k, 9.5 * k, true, colW - 40 * k, 2, measure);
      const cxm = m + colW * i + colW / 2;
      const d = 24 * k;
      const widest = Math.max(...f.lines.map((l) => measure.width(l, f.size, true)));
      const total = d + 8 * k + widest;
      const x0 = cxm - total / 2;
      ops.push({ k: 'rect', x: x0, y: by + (stepsH - d) / 2, w: d, h: d, r: d / 2, fill: COLORS.orange });
      text(String(i + 1), x0 + d / 2, by + stepsH / 2 + 14 * k * 0.35, 14 * k, true, COLORS.navy, 'center');
      const lh = f.lines.length * f.size * LINE_HEIGHT;
      lines(f.lines, x0 + d + 8 * k, by + (stepsH - lh) / 2, f.size, true, COLORS.navy, 'left');
    });
    by += stepsH + gap;
  }
  if (urlFit) lines(urlFit.lines, mid, by, urlFit.size, true, COLORS.navy, 'center');

  // ---- footer render ----------------------------------------------------------------------------------------
  if (foot.length) {
    let fy = footTop;
    if (premium) {
      ops.push({ k: 'rect', x: m, y: footTop, w: cw, h: footH, r: 14 * k, fill: COLORS.softOrange });
      fy += footPad;
    } else {
      ops.push({ k: 'rect', x: m, y: footTop, w: cw, h: 1.2 * k, r: 0, fill: COLORS.orange });
      fy += 12 * k;
    }
    foot.forEach((f, i) => { fy += lines(f.ls, mid, fy, f.size, f.bold, f.color, 'center') + (i < foot.length - 1 ? footGap : 0); });
  }

  return { width: W, height: H, margin: m, ops, qrText: url, qrBox: { x: qx, y: qy, size: qrSize, cell, n }, replaced };
}
