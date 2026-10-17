// Test helper: reads the content stream of a generated poster PDF and rasterises its axis-aligned filled shapes
// (the QR modules and the white quiet-zone square) so the real PDF, not just the layout model, can be decoded.
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import jsQR from 'jsqr';

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]
];

export interface PdfInfo { width: number; height: number; stream: string; fonts: string[]; raw: string }

export async function readPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const doc = await PDFDocument.load(bytes);
  if (doc.getPageCount() !== 1) throw new Error(`expected 1 page, got ${doc.getPageCount()}`);
  const page = doc.getPage(0);
  const { width, height } = page.getSize();
  const contents: any = page.node.Contents();
  const refs = contents.asArray ? contents.asArray() : [contents];
  let stream = '';
  for (const r of refs) stream += Buffer.from(decodePDFRawStream(doc.context.lookup(r) as PDFRawStream).decode()).toString('latin1') + '\n';
  const fonts = Buffer.from(bytes).toString('latin1').match(/\/BaseFont\s*\/[A-Za-z-]+/g) ?? [];
  return { width, height, stream, fonts, raw: Buffer.from(bytes).toString('latin1') };
}

export interface Raster { w: number; h: number; rgba: Uint8ClampedArray }

/** Rasterise at `ppp` pixels per point. Curved paths (rounded panels, glyphs) are skipped: only QR geometry matters here. */
export function rasterise(info: PdfInfo, ppp: number): Raster {
  const w = Math.ceil(info.width * ppp), h = Math.ceil(info.height * ppp);
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const stack: { ctm: M; fill: [number, number, number] }[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  let fill: [number, number, number] = [0, 0, 0];
  let rects: [number, number, number, number][] = [];
  let sub: [number, number][] = [];
  let curved = false;
  const tp = (x: number, y: number): [number, number] => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]];
  const closeSub = () => {
    if (sub.length === 4) {
      const xs = sub.map((p) => p[0]), ys = sub.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const axis = sub.every((p) => xs.filter((x) => Math.abs(x - p[0]) < 1e-6).length >= 2 && ys.filter((y) => Math.abs(y - p[1]) < 1e-6).length >= 2);
      if (axis) rects.push([x0, y0, x1, y1]); else curved = true;
    } else if (sub.length) curved = true;
    sub = [];
  };
  for (const line of info.stream.split('\n')) {
    const t = line.trim().split(/\s+/);
    const op = t[t.length - 1];
    const n = t.slice(0, -1).map(Number);
    if (op === 'q') stack.push({ ctm, fill });
    else if (op === 'Q') { const s = stack.pop(); if (s) { ctm = s.ctm; fill = s.fill; } }
    else if (op === 'cm') ctm = mul(n as M, ctm);
    else if (op === 'rg') fill = [n[0]! * 255, n[1]! * 255, n[2]! * 255];
    else if (op === 'm') { closeSub(); sub = [tp(n[0]!, n[1]!)]; }
    else if (op === 'l') sub.push(tp(n[0]!, n[1]!));
    else if (op === 'c') curved = true;
    else if (op === 'h') closeSub();
    else if (op === 're') { const [x, y, rw, rh] = n as [number, number, number, number]; const a = tp(x, y), b = tp(x + rw, y + rh); rects.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]); }
    else if (op === 'f' || op === 'f*') {
      closeSub();
      if (!curved) {
        for (const [x0, y0, x1, y1] of rects) {
          // PDF y is up; the bitmap is top-down.
          const px0 = Math.round(x0 * ppp), px1 = Math.round(x1 * ppp);
          const py0 = Math.round((info.height - y1) * ppp), py1 = Math.round((info.height - y0) * ppp);
          for (let y = Math.max(0, py0); y < Math.min(h, py1); y++) for (let x = Math.max(0, px0); x < Math.min(w, px1); x++) {
            const i = (y * w + x) * 4; rgba[i] = fill[0]; rgba[i + 1] = fill[1]; rgba[i + 2] = fill[2]; rgba[i + 3] = 255;
          }
        }
      }
      rects = []; sub = []; curved = false;
    } else if (op === 'S' || op === 'B' || op === 'n') { rects = []; sub = []; curved = false; }
  }
  return { w, h, rgba };
}

/** 3x3 box blur: a crude stand-in for ink spread / optical softness. */
export function blur(r: Raster): Raster {
  const out = new Uint8ClampedArray(r.rgba.length);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) for (let c = 0; c < 3; c++) {
    let s = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < r.w && yy < r.h) { s += r.rgba[(yy * r.w + xx) * 4 + c]!; k++; }
    }
    out[(y * r.w + x) * 4 + c] = s / k;
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { w: r.w, h: r.h, rgba: out };
}

export function decode(r: Raster): string | null {
  return jsQR(r.rgba, r.w, r.h, { inversionAttempts: 'dontInvert' })?.data ?? null;
}
