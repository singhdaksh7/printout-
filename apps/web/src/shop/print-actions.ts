import { printNow, requestDocumentDownload } from '../lib/shop-api';

/** Shown next to every Save File button: the local copy is the shop's own, the server copy is still deleted on schedule. */
export const SAVE_FILE_NOTE = "Saved copies on this device are managed by you. Printout's temporary copy will still be deleted automatically.";

/**
 * Print Now: opens the viewer tab synchronously (so popup blockers allow it), asks the server to move the order to
 * PRINTING and issue short-lived INLINE access, then points the tab at the document. The tab is closed again if the
 * server refuses. Opening/printing never marks the order printed: that needs the explicit confirmation.
 */
export async function printNowAndOpen(orderId: string) {
  let w: Window | null = null;
  try { w = typeof window.open === 'function' ? window.open('', '_blank') : null; } catch { w = null; }
  try {
    const r = await printNow(orderId);
    if (w) { try { w.opener = null; } catch { /* ignore */ } w.location.href = r.access.url; }
    return r;
  } catch (e) {
    try { w?.close(); } catch { /* ignore */ }
    throw e;
  }
}

/** Save File: an explicit, user-initiated download of the original document (Content-Disposition: attachment). */
export async function saveFileToDevice(orderId: string) {
  const r = await requestDocumentDownload(orderId);
  const a = document.createElement('a');
  a.href = r.url;
  a.download = r.fileName || 'document';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return r;
}
