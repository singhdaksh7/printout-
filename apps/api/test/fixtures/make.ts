import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';

/** Programmatically generated fixtures: nothing binary is checked in. */

export async function makePdf(pages: number, useObjectStreams = true): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]);
  return Buffer.from(await doc.save({ useObjectStreams }));
}

/** Hand-written PDF whose trailer carries an /Encrypt dictionary (standard handler, RC4-40). */
export function makeEncryptedPdf(): Buffer {
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>',
    `<</Filter/Standard/V 1/R 2/O<${'ab'.repeat(32)}>/U<${'cd'.repeat(32)}>/P -4>>`
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R/Encrypt 4 0 R/ID[<${'11'.repeat(16)}><${'11'.repeat(16)}>]>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export async function makeTruncatedPdf(): Promise<Buffer> {
  const full = await makePdf(3, false);
  return full.subarray(0, Math.floor(full.length / 2));
}

/** A Windows PE header, as would be uploaded by someone renaming malware to .pdf. */
export const makeExe = (): Buffer => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90), Buffer.from('This program cannot be run in DOS mode.')]);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Valid PNG header/IHDR/IEND with the claimed dimensions; pixel data is a single tiny row (enough for a structural check). */
export function makePng(width = 2, height = 2): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = Math.min(height, 4);
  const raw = Buffer.alloc(rows * (1 + Math.min(width, 4) * 3), 0x7f);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Structurally valid JPEG: SOI, APP0, SOF0 (w x h), SOS + entropy data, EOI. */
export function makeJpeg(width = 4, height = 4): Buffer {
  const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), u16(16), Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
  const sof = Buffer.concat([Buffer.from([0xff, 0xc0]), u16(11), Buffer.from([8]), u16(height), u16(width), Buffer.from([1, 1, 0x11, 0])]);
  const sos = Buffer.concat([Buffer.from([0xff, 0xda]), u16(8), Buffer.from([1, 1, 0, 0, 63, 0]), Buffer.alloc(16, 0x55)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, sos, Buffer.from([0xff, 0xd9])]);
}
