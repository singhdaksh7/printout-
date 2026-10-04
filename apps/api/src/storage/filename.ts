/**
 * Original filenames are METADATA ONLY: never used to build storage paths.
 * Strips directory components, control/bidi characters and shell-ish punctuation, bounds the length (keeping the extension).
 */
export function sanitizeFilename(input: string, maxLength = 120): string {
  let name = String(input ?? '').normalize('NFC');
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/[:*?"<>|%$`;&]/g, '_').replace(/\s+/g, ' ').trim();
  name = name.replace(/^[.\s_-]+/, '').replace(/[.\s]+$/, '');
  if (name.length > maxLength) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, maxLength - ext.length) + ext;
  }
  return name || 'document';
}

/** ASCII-only fallback plus RFC 5987 encoded name for Content-Disposition. */
export function contentDispositionInline(filename: string): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
