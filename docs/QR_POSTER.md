# QR poster generator

Shopkeepers design and download a branded, print-ready poster that sends customers to their own upload page.
Route: `/shop/qr/poster` (button **Design a branded poster** on `QR & standee`). The older counter poster ("Print A4 poster", `?poster=1`) and the QR/PNG/SVG downloads on `QR & standee` are unchanged.

## What the poster says

| Item | Source |
|---|---|
| Shop name | session `shop.displayName` (fallback `GET /shop/qr` `shopName`) |
| QR code and link | `GET /shop/qr` `publicUrl` = `WEB_ORIGIN` (server config, https in production) + `/p/<slug>`. Nothing is hard-coded. |
| Call to action | default "Scan to upload documents"; editable, max 40 characters |
| Address, contact | `GET /shop/settings` `address`, `publicContact`. **Opt-in** (off by default), disabled with a link to Settings when empty |
| Link text, deletion note | on by default, can be switched off. The note uses the session `retentionMinutes` |
| Printout Buddy mark | `poster/brand.ts` (existing app icon artwork + wordmark) |

**QR content is exactly `<origin>/p/<slug>`** and nothing else. `validatePublicUrl` rejects any other path, query, hash, credentials or non-http(s) scheme, and `buildPoster` throws rather than repairing a bad URL. No admin, order, document or storage URL, no customer data, no tracking parameters.

## Templates and formats

| Template | Look |
|---|---|
| Classic | white page, orange header block, navy type, soft-orange panel behind a large QR, three steps |
| Premium | navy header block, orange call-to-action pill, white card with navy outline around the QR, soft-orange footer |
| Minimal | white page, brand line, shop name, centred large QR, thin orange rule |

Colours: orange `#E8772E`, navy `#14213D`, soft orange `#FFF4EA`, white, plus one navy-grey for secondary text. No gradients, shadows, images or overlays; a test fails if any other colour is used or anything is painted over the QR.

| Export | Details |
|---|---|
| PDF | A4 (210x297 mm) or A5 (148x210 mm) portrait, single page, vector. QR is one filled path (no seams between modules). Text is standard Helvetica / Helvetica-Bold, referenced by name (no font files, nothing fetched, nothing embedded from the network). File name `printout-buddy-poster-<slug>-<a4|a5>.pdf`. |
| PNG | 300 dpi (2480x3508 for A4), same layout, QR snapped to whole pixels per module. |

Margins: 12 mm (A4) and 10 mm (A5) are kept clear on every side, so home printers that cannot print to the edge never clip content. Nothing bleeds. Fonts and spacing scale with the page, so A5 is A4 scaled by 0.705.

## QR quality rules (enforced by tests)

- Error correction level Q; **4-module quiet zone** on all sides, drawn as a white square before the modules.
- Dark navy modules on white; no logo in the QR centre; nothing decorative is allowed inside the quiet zone.
- QR size is the largest that fits (about 310 pt, 380 pt on Minimal). Module pitch is at least 1.8 mm for normal content and never below 1.2 mm with the longest allowed name, address and contact.
- Long shop names wrap to three lines and shrink from 44 pt to 24 pt (the last line is shortened with "..." only beyond that). Long links break between characters.

## Safety

- Poster settings are **not stored on the server** (no migration, no API change). Template, paper size, call to action and the four toggles are kept in the browser (`localStorage`, key `pb.qr-poster.v1:<slug>`) and every value is re-validated on load; tampered values fall back to defaults.
- The page is behind the existing shop login; the QR data comes from the authenticated `/shop/qr` of the session's own shop, so another shop's data is unreachable.
- Shop name, call to action, address and contact are untrusted: control and bidi characters are stripped, length is capped, and characters outside the PDF font's range (Latin letters, digits, common punctuation, accented Latin) are replaced by `?` with a visible warning. React renders the preview (escaped); the PDF contains only drawing operators and text strings (no scripts, links, actions or attachments; asserted by a test).
- File names are `[a-z0-9-]` only. No logo upload exists in the product, so no image is fetched, decoded or embedded.
- Limitation: shop names in other scripts (for example Devanagari) cannot be drawn with the built-in PDF fonts yet and show as `?`.

## Printing instructions (shown in the app)

1. Open the PDF and choose the matching paper (A4 or A5).
2. Scale **100% / Actual size**, never "Fit to page".
3. Highest print quality; colour looks best, black and white still scans.
4. Scan the printed poster with your own phone before displaying it.

## Tests

- `apps/web/src/shop/poster/__tests__/poster.test.ts`: the real PDF is read back (content stream decompressed and rasterised, QR decoded with jsQR) for 4 slugs x 3 templates x 2 sizes on 3 origins (including a port and a sub-domain); decoded again at 72, 108, 150 and 300 dpi, with 3x3 blur, and scaled to ~49% (A4 printed as A6). Also: page size, one page, standard fonts, margins respected, no text over the QR or other text, long names, hostile names, no scripts or URIs in the PDF, palette, quiet zone, URL and settings validation, safe file names.
- `apps/web/src/shop/__tests__/poster-page.test.tsx`: page behaviour, persistence, tampered storage, escaping, downloads, error and empty states, keyboard.
- `e2e/12-qr-poster.spec.ts`: browser download of every template x size, PDF size and decoded URL (against the configured `WEB_ORIGIN` and exact slug), PNG dimensions and decoded URL, persistence, reset, keyboard, axe, tenant isolation, login redirect, 360/390/768/1440 px screenshots.

## Branding

The mark is isolated in `poster/brand.ts`. It is reconciled with the approved Buddy printer logo (PR #19, docs/design/1.pdf p1), matching the product identity across PDF, PNG and live preview.

