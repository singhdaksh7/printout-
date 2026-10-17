// PNG writer (browser): same operations as the PDF, rasterised at 300 dpi. The QR is snapped to whole pixels per module
// so edges stay crisp and decode reliably.
import type { Poster } from './layout';

export const PNG_DPI = 300;
const FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';

export function renderPng(poster: Poster, dpi = PNG_DPI): Promise<Blob> {
  const scale = dpi / 72;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(poster.width * scale);
  canvas.height = Math.round(poster.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas is not available'));
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);

  for (const op of poster.ops) {
    if (op.k === 'rect') {
      ctx.beginPath();
      if (op.r > 0.01 && typeof ctx.roundRect === 'function') ctx.roundRect(op.x, op.y, op.w, op.h, op.r);
      else ctx.rect(op.x, op.y, op.w, op.h);
      if (op.fill) { ctx.fillStyle = op.fill; ctx.fill(); }
      if (op.stroke) { ctx.strokeStyle = op.stroke; ctx.lineWidth = op.strokeW ?? 1; ctx.stroke(); }
    } else if (op.k === 'path') {
      ctx.save();
      ctx.translate(op.x, op.y);
      ctx.scale(op.scale, op.scale);
      ctx.fillStyle = op.fill;
      ctx.fill(new Path2D(op.d));
      ctx.restore();
    } else if (op.k === 'qr') {
      const px = Math.max(1, Math.round(op.cell * scale));
      const ox = Math.round(op.x * scale), oy = Math.round(op.y * scale);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = op.color;
      for (let r = 0; r < op.n; r++) for (let c = 0; c < op.n; c++) if (op.bits[r * op.n + c]) ctx.fillRect(ox + c * px, oy + r * px, px, px);
      ctx.restore();
    } else {
      ctx.font = `${op.bold ? '700' : '400'} ${op.size}px ${FONT}`;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align === 'center' ? 'center' : 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(op.text, op.x, op.y);
    }
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

