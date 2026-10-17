// Text measurement with the PDF standard Helvetica metrics (what the PDF uses), shared by layout, preview and PNG.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Measure } from './layout';

let cached: Promise<Measure> | null = null;
export function getMeasure(): Promise<Measure> {
  cached ??= (async () => {
    const doc = await PDFDocument.create();
    const reg = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    return { width: (t, size, b) => (b ? bold : reg).widthOfTextAtSize(t, size) };
  })();
  return cached;
}
