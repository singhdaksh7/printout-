// PDF writer: vector QR (one filled path, no seams), standard Helvetica (no external fonts, nothing fetched), exact page size.
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import type { Poster } from './layout';
import { qrPath, roundedRectPath } from './paths';

const hex = (c: string) => {
  const v = parseInt(c.slice(1), 16);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
};

export interface PdfMeta { title: string }

export async function renderPdf(poster: Poster, meta: PdfMeta): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(meta.title);
  doc.setAuthor('Printout Buddy');
  doc.setCreator('Printout Buddy poster generator');
  doc.setProducer('Printout Buddy');
  doc.setSubject('Scan to upload documents');
  const fonts: { reg: PDFFont; bold: PDFFont } = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold)
  };
  const page = doc.addPage([poster.width, poster.height]);
  const H = poster.height;

  for (const op of poster.ops) {
    if (op.k === 'rect') {
      const color = op.fill ? hex(op.fill) : undefined;
      const border = op.stroke ? hex(op.stroke) : undefined;
      if (op.r > 0.01) {
        page.drawSvgPath(roundedRectPath(op.w, op.h, op.r), { x: op.x, y: H - op.y, color, borderColor: border, borderWidth: op.strokeW ?? 0 });
      } else {
        page.drawRectangle({ x: op.x, y: H - op.y - op.h, width: op.w, height: op.h, color, borderColor: border, borderWidth: op.strokeW ?? 0 });
      }
    } else if (op.k === 'path') {
      page.drawSvgPath(op.d, { x: op.x, y: H - op.y, scale: op.scale, color: hex(op.fill) });
    } else if (op.k === 'qr') {
      page.drawSvgPath(qrPath(op), { x: op.x, y: H - op.y, color: hex(op.color) });
    } else {
      const font = op.bold ? fonts.bold : fonts.reg;
      const w = font.widthOfTextAtSize(op.text, op.size);
      page.drawText(op.text, { x: op.align === 'center' ? op.x - w / 2 : op.x, y: H - op.y, size: op.size, font, color: hex(op.color) });
    }
  }
  return doc.save();
}
