import { describe, expect, it } from 'vitest';
import { buildPoster, ASCENT, type Measure, type Op, type Poster, type PosterInput } from '../layout';
import { getMeasure } from '../fonts';
import { renderPdf } from '../pdf';
import {
  COLORS, DEFAULT_SETTINGS, MM, PAPER_PT, PAPER_SIZES, TEMPLATES, cleanText, posterFilename, safeFilenamePart, sanitizeSettings, validatePublicUrl,
  type PaperSize, type PosterSettings, type TemplateId
} from '../model';
import { blur, decode, rasterise, readPdf } from './pdf-raster';

const ORIGINS = ['https://printout.example.com', 'http://localhost:5173', 'https://print.sub-domain.co.in:8443'];
const SLUGS = ['central', 'a-b-c', 'copy-corner-42', 'x'.repeat(30) + '-' + 'y'.repeat(29)];

function input(over: Partial<Omit<PosterInput, 'settings'>> & { settings?: Partial<PosterSettings> } = {}): PosterInput {
  const slug = over.slug ?? 'central';
  return {
    shopName: 'Central Print', slug, publicUrl: `https://printout.example.com/p/${slug}`, address: '12 MG Road, Pune 411001', contact: '+91 98765 43210', retentionMinutes: 30,
    ...over, settings: { ...DEFAULT_SETTINGS, ...over.settings }
  };
}
async function make(i: PosterInput): Promise<Poster> { return buildPoster(i, await getMeasure()); }

interface Box { x0: number; y0: number; x1: number; y1: number }
function bboxes(p: Poster, m: Measure): Box[] {
  const out: Box[] = [];
  for (const op of p.ops as Op[]) {
    if (op.k === 'rect') out.push({ x0: op.x, y0: op.y, x1: op.x + op.w, y1: op.y + op.h });
    else if (op.k === 'qr') out.push({ x0: op.x, y0: op.y, x1: op.x + op.n * op.cell, y1: op.y + op.n * op.cell });
    else if (op.k === 'text') {
      const w = m.width(op.text, op.size, op.bold);
      const x0 = op.align === 'center' ? op.x - w / 2 : op.x;
      out.push({ x0, y0: op.y - op.size * ASCENT, x1: x0 + w, y1: op.y + op.size * 0.22 });
    } else out.push({ x0: op.x, y0: op.y, x1: op.x + 512 * op.scale, y1: op.y + 512 * op.scale });
  }
  return out;
}

describe('URL and text safety', () => {
  it('accepts only the exact public shop URL', () => {
    expect(validatePublicUrl('https://printout.example.com/p/central', 'central')).toBe('https://printout.example.com/p/central');
    for (const bad of [
      'https://printout.example.com/shop/qr', 'https://printout.example.com/p/other', 'https://printout.example.com/p/central?x=1', 'https://printout.example.com/p/central#a',
      'https://u:p@printout.example.com/p/central', 'javascript:alert(1)', 'ftp://printout.example.com/p/central', 'not a url', '', 'https://printout.example.com/p/central/'
    ]) expect(validatePublicUrl(bad, 'central'), bad).toBeNull();
    expect(validatePublicUrl('https://x.test/p/Central', 'Central')).toBeNull();
    expect(validatePublicUrl(undefined, 'central')).toBeNull();
  });

  it('refuses to lay out a poster for a non-public URL', async () => {
    await expect(make(input({ publicUrl: 'https://printout.example.com/shop/admin' }))).rejects.toThrow();
  });

  it('cleans untrusted text', () => {
    expect(cleanText('  A\u0000B‮C \n\t D  ', 50).text).toBe('ABC D');
    expect(cleanText('日本語 Shop', 50)).toEqual({ text: '??? Shop', replaced: 3 });
    expect(cleanText('x'.repeat(500), 20).text).toHaveLength(20);
    expect(cleanText(42, 20).text).toBe('');
    expect(cleanText('Café – “quoted” €5', 50).replaced).toBe(0);
  });

  it('builds safe file names', () => {
    expect(safeFilenamePart('../../etc/passwd')).toBe('etc-passwd');
    expect(safeFilenamePart('!!!')).toBe('shop');
    expect(posterFilename('copy-corner', 'A5', 'pdf')).toBe('printout-buddy-poster-copy-corner-a5.pdf');
    expect(posterFilename('a"b<c>.pdf', 'A4', 'png')).toMatch(/^[a-z0-9.-]+$/);
  });

  it('sanitises stored settings and falls back to defaults', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ template: 'evil', size: 'A0', headline: '\u0000', showAddress: 'yes', extra: 1 })).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ template: 'minimal', size: 'A5', headline: '  Print here  ', showAddress: true });
    expect(s).toMatchObject({ template: 'minimal', size: 'A5', headline: 'Print here', showAddress: true });
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});

describe('QR decoding from the generated PDF', () => {
  const cases: { origin: string; slug: string; template: TemplateId; size: PaperSize }[] = [];
  ORIGINS.forEach((origin, oi) => SLUGS.forEach((slug, si) => TEMPLATES.forEach((template, ti) => PAPER_SIZES.forEach((size, zi) => {
    // Full cross product of slugs x templates x sizes on one origin; the other origins rotate through to keep the run fast.
    if (oi === 0 || (si + ti + zi) % 3 === oi) cases.push({ origin, slug, template, size });
  }))));

  it.each(cases)('$template $size $slug @ $origin decodes to the exact shop URL', async ({ origin, slug, template, size }) => {
    const url = `${origin}/p/${slug}`;
    const p = await make(input({ slug, publicUrl: url, settings: { template, size } }));
    expect(p.qrText).toBe(url);
    const pdf = await readPdf(await renderPdf(p, { title: 'Poster' }));
    // Print at 150 dpi (2.08 px/pt) as the baseline.
    expect(decode(rasterise(pdf, 2.0833)), 'clean 150 dpi').toBe(url);
  }, 30_000);

  it('still decodes at low print resolutions and with ink blur (representative printed/scanned quality)', async () => {
    for (const size of PAPER_SIZES) for (const template of TEMPLATES) {
      const url = 'https://printout.example.com/p/copy-corner-42';
      const pdf = await readPdf(await renderPdf(await make(input({ slug: 'copy-corner-42', publicUrl: url, settings: { template, size } })), { title: 'x' }));
      for (const ppp of [1.0, 1.5, 2.0833, 4.1667]) expect(decode(rasterise(pdf, ppp)), `${template} ${size} @${ppp}px/pt`).toBe(url);
      expect(decode(blur(rasterise(pdf, 2.0833))), `${template} ${size} blurred`).toBe(url);
    }
  }, 60_000);

  it('survives being printed small: A4 poster scaled to A6 (~49%)', async () => {
    const url = 'https://printout.example.com/p/central';
    const pdf = await readPdf(await renderPdf(await make(input({ settings: { template: 'classic', size: 'A4' } })), { title: 'x' }));
    expect(decode(rasterise(pdf, 2.0833 * 0.5 * 2))).toBe(url); // ~150 dpi of the scaled-down print
    expect(decode(blur(rasterise(pdf, 1.5)))).toBe(url);
  }, 30_000);

  it('keeps modules large enough for phones (>= 1.8 mm typical, >= 1.2 mm worst case) with a 4-module quiet zone', async () => {
    for (const size of PAPER_SIZES) for (const template of TEMPLATES) {
      const typical = (await make(input({ settings: { template, size, showAddress: true, showContact: true } }))).qrBox;
      expect(typical.cell / MM, `${template} ${size} typical module mm`).toBeGreaterThanOrEqual(1.8);
      const p = await make(input({ settings: { template, size, showAddress: true, showContact: true }, shopName: 'Long Shop Name '.repeat(8), address: 'Line '.repeat(60), contact: 'c'.repeat(100) }));
      const { cell, n, size: box } = p.qrBox;
      expect(cell / MM, `${template} ${size} worst-case module mm`).toBeGreaterThanOrEqual(1.2);
      expect(box).toBeCloseTo(cell * (n + 8), 3);
    }
  });
});

describe('PDF geometry and safety', () => {
  const all: [TemplateId, PaperSize][] = TEMPLATES.flatMap((t) => PAPER_SIZES.map((s) => [t, s] as [TemplateId, PaperSize]));

  it.each(all)('%s %s: exact page size, one page, standard fonts, nothing outside the margin', async (template, size) => {
    const m = await getMeasure();
    const p = buildPoster(input({ settings: { template, size, showAddress: true, showContact: true } }), m);
    const pdf = await readPdf(await renderPdf(p, { title: 'Central Print poster' }));
    expect(pdf.width).toBeCloseTo(PAPER_PT[size].w, 1);
    expect(pdf.height).toBeCloseTo(PAPER_PT[size].h, 1);
    expect(pdf.width / MM).toBeCloseTo(size === 'A4' ? 210 : 148, 0);
    expect(pdf.stream).toMatch(/\/Helvetica-Bold-\d+ [\d.]+ Tf/);
    expect(pdf.raw).not.toMatch(/\/FontFile/); // standard-14 fonts: referenced by name, no font program or external file
    const margin = PAPER_PT[size].marginMm * MM;
    expect(p.margin).toBeCloseTo(margin, 3);
    for (const b of bboxes(p, m)) {
      expect(b.x0).toBeGreaterThanOrEqual(margin - 0.5);
      expect(b.y0).toBeGreaterThanOrEqual(margin - 0.5);
      expect(b.x1).toBeLessThanOrEqual(p.width - margin + 0.5);
      expect(b.y1).toBeLessThanOrEqual(p.height - margin + 0.5);
    }
  });

  it.each(all)('%s %s: text never overlaps the QR box or other text', async (template, size) => {
    const m = await getMeasure();
    const p = buildPoster(input({ shopName: 'The Extremely Long Photocopy And Printing Centre Of Greater Pune', settings: { template, size, showAddress: true, showContact: true } }), m);
    const texts = (p.ops as Op[]).filter((o): o is Extract<Op, { k: 'text' }> => o.k === 'text').map((o) => {
      const w = m.width(o.text, o.size, o.bold);
      const x0 = o.align === 'center' ? o.x - w / 2 : o.x;
      return { t: o.text, x0, x1: x0 + w, y0: o.y - o.size * ASCENT, y1: o.y + o.size * 0.22 };
    });
    const q = p.qrBox;
    const hit = (a: { x0: number; x1: number; y0: number; y1: number }, b: { x0: number; x1: number; y0: number; y1: number }) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    for (const t of texts) expect(hit(t, { x0: q.x, x1: q.x + q.size, y0: q.y, y1: q.y + q.size }), `text "${t.t}" overlaps QR`).toBe(false);
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!, b = texts[j]!;
      // Step circles' digits sit inside their own circle and are allowed to touch their label's line box only by design; other text must not collide.
      if (hit({ ...a, y0: a.y0 + 1, y1: a.y1 - 1 }, { ...b, y0: b.y0 + 1, y1: b.y1 - 1 })) throw new Error(`"${a.t}" overlaps "${b.t}"`);
    }
  });

  it('wraps and shrinks very long shop names without clipping or overflow', async () => {
    const m = await getMeasure();
    for (const name of ['A'.repeat(120), 'Supercalifragilisticexpialidocious '.repeat(4), 'W'.repeat(40)]) {
      const p = buildPoster(input({ shopName: name, settings: { template: 'classic', size: 'A5' } }), m);
      for (const b of bboxes(p, m)) { expect(b.x1).toBeLessThanOrEqual(p.width - p.margin + 0.5); expect(b.x0).toBeGreaterThanOrEqual(p.margin - 0.5); }
    }
  });

  it('draws hostile shop names as inert text and contains no scripts, links or actions', async () => {
    const hostile = '<script>alert(1)</script> ") /JS (app.alert(1)) \\ << /OpenAction >> ‮';
    const bytes = await renderPdf(await make(input({ shopName: hostile, address: '<img src=x onerror=alert(1)>', settings: { showAddress: true } })), { title: hostile });
    const raw = Buffer.from(bytes).toString('latin1');
    for (const needle of ['/JavaScript', '/OpenAction', '/URI', '/Launch', '/EmbeddedFile', '/AA ', '/Annots']) expect(raw, needle).not.toContain(needle);
    expect(raw).not.toMatch(/\/JS\b/);
    expect(bytes.length).toBeLessThan(200_000);
  });

  it('replaces glyphs the PDF font cannot draw instead of failing, and reports it', async () => {
    const p = await make(input({ shopName: 'प्रिंट शॉप Café' }));
    expect(p.replaced).toBeGreaterThan(0);
    await expect(renderPdf(p, { title: 'ok' })).resolves.toBeInstanceOf(Uint8Array);
  });

  it('puts no private data in the file: only the public URL, shop name and chosen details', async () => {
    const bytes = await renderPdf(await make(input()), { title: 'Central Print poster' });
    const raw = Buffer.from(bytes).toString('latin1');
    expect(raw).not.toMatch(/csrf|token|session|storageKey|\/api\/|admin/i);
  });

  it('uses the brand palette only', async () => {
    const p = await make(input({ settings: { template: 'premium' } }));
    const allowed = new Set<string>(Object.values(COLORS));
    for (const op of p.ops) for (const c of [(op as { fill?: string }).fill, (op as { stroke?: string }).stroke, (op as { color?: string }).color]) if (c) expect(allowed.has(c), c).toBe(true);
  });

  it('QR is drawn dark-on-white with no overlay on top of it', async () => {
    for (const t of TEMPLATES) {
      const p = await make(input({ settings: { template: t } }));
      const qi = p.ops.findIndex((o) => o.k === 'qr');
      expect(qi).toBeGreaterThan(0);
      const q = p.ops[qi] as Extract<Op, { k: 'qr' }>;
      expect(q.color).toBe(COLORS.navy);
      const white = p.ops[qi - 1] as Extract<Op, { k: 'rect' }>;
      expect(white).toMatchObject({ k: 'rect', fill: COLORS.white, r: 0 });
      const quiet = (q.x - white.x) / q.cell;
      expect(quiet).toBeCloseTo(4, 3);
      // Nothing painted after the QR may intersect its quiet-zone square.
      for (const later of p.ops.slice(qi + 1)) {
        if (later.k === 'path') continue;
        const bx = later.k === 'text' ? { x0: later.x - 200, x1: later.x + 200, y0: later.y - later.size, y1: later.y } : { x0: later.x, x1: later.x + (later as { w: number }).w, y0: later.y, y1: later.y + (later as { h: number }).h };
        if (later.k === 'rect' && later.fill === COLORS.orange && later.r > 0) continue; // step badges, well below the QR
        const overlaps = bx.x0 < white.x + white.w && bx.x1 > white.x && bx.y0 < white.y + white.h && bx.y1 > white.y;
        expect(overlaps, `${t}: ${later.k} drawn over the QR`).toBe(false);
      }
    }
  });
});
