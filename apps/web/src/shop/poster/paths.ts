// SVG path helpers shared by the PDF writer and the on-screen preview.
import type { Op } from './layout';

const f = (n: number) => Number(n.toFixed(3));

export function roundedRectPath(w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return `M ${f(rr)} 0 H ${f(w - rr)} A ${f(rr)} ${f(rr)} 0 0 1 ${f(w)} ${f(rr)} V ${f(h - rr)} A ${f(rr)} ${f(rr)} 0 0 1 ${f(w - rr)} ${f(h)} H ${f(rr)} A ${f(rr)} ${f(rr)} 0 0 1 0 ${f(h - rr)} V ${f(rr)} A ${f(rr)} ${f(rr)} 0 0 1 ${f(rr)} 0 Z`;
}

/** One closed square per dark run, merged horizontally, all in a single path so adjacent modules never show hairline seams. */
export function qrPath(op: Extract<Op, { k: 'qr' }>): string {
  const { n, bits, cell } = op;
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!bits[r * n + c]) { c++; continue; }
      let e = c;
      while (e < n && bits[r * n + e]) e++;
      d += `M ${f(c * cell)} ${f(r * cell)} h ${f((e - c) * cell)} v ${f(cell)} h ${f(-(e - c) * cell)} Z `;
      c = e;
    }
  }
  return d.trim();
}
