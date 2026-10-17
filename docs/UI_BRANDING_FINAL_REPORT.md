# Orange-primary UI and branding: final report

Date: 2026-10-17. Branch `feature/daksh-orange-primary-ui`, baseline `origin/development` at `dacf051`.

## What changed

**Branding (approved mark only).** `docs/design/1.pdf` p1 is the approved "Buddy printer" mark (paper on top, a face on the printer body, pixels fading out below). The PDF page is a raster image, so the mark was rebuilt as vector SVG by measuring the approved artwork (tile, body, eyes, smile and pixel geometry on a 100-unit tile). Fidelity against the approved artwork, rendered in Chromium: mean absolute difference 2.6 / 255, 98.4 % of interior pixels within 40 / 255 (`docs/visual-qa/logo-fidelity.png`). No new logo was designed; the generic printer glyph and the blue placeholder icon are gone.

| Asset | Use |
|---|---|
| `BrandMark` / `BrandLogo` (`ui/navigation/navigation.tsx`) | full mark from 64 px, simple mark (no smile, three larger pixels) at 48 px and below, `compact` lockup for narrow spaces, orange or navy tile; wordmark "Printout" + "Buddy" (orange-ink on light, orange on navy); accessible name "PrintoutBuddy" |
| `public/brand-mark.svg`, `brand-mark-navy.svg`, `brand-mark-simple.svg` | static vector copies |
| `public/icon.svg` | favicon (simple mark) |
| `public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | PWA / apple-touch icons, rendered with Chromium; the maskable icon keeps the artwork inside the 80 % safe zone |
| `index.html`, `vite.config.ts` manifest | title and name PrintoutBuddy, theme colour navy `#14213D`, background paper `#FBFBF8` |

**UI polish found by the audit.**

| Finding | Fix |
|---|---|
| Focus ring on the navy sidebar was info blue on navy, 2.47:1 (needs 3:1) | white ring inside the sidebar (16:1) |
| Route-level loading was unbranded plain text | brand mark with a visible "Loading…" label, reduced-motion safe |
| Admin shop detail: four narrow cards, owner e-mail and prices broke per character | wider cards, stacked label/value layout |
| Admin orders: "1 copies" | "1 copy" |
| Back links stretched and centred their label | left aligned |
| Disconnected device cards faded with `opacity: .75`, pushing chip text under 4.5:1 | flat tint and dashed border, no opacity |
| Mobile card list put the "Load more" footer inside `role="list"` (aria-required-children) | footer moved beside the list |
| Rate card: a slow earlier/later load response could reset prices the shopkeeper was typing (React StrictMode runs the load effect twice) | only the latest load may update the form; deterministic regression test `e2e/12-pricing-late-load.spec.ts` (failed before the fix, passes after) |
| Leftover blue legacy variable, blue example colour in Shop Settings, duplicate token line | removed or changed to the brand orange |

Orange (`#E8772E`) is the one primary action colour (navy label, 5.4:1) and never carries text on light surfaces (`--pb-orange-ink` `#B04E17`, 5.1:1). Navy stays the sidebar and navigation background. All values are `--pb-*` tokens; no scattered hex values were added.

## Evidence

Screenshots: 26 screens x 4 widths (360, 390, 768, 1440) = 104 per set, for Customer (landing, options and quote, validation error, order confirmation, tracking, not found), Shopkeeper (login, queue, notifications, order detail, history, revenue, devices, rate card, QR, settings) and Admin (login, dashboard, shops, create shop, shop detail, orders, subscriptions, plans, audit, account).

- Before/after comparison sheets: `docs/visual-qa/compare/<area>-<width>-<n>.jpg` (left: `origin/development` `dacf051`, right: after). Built from the third capture run, so they predate the last two accessibility fixes (devices opacity, history list footer), which change only those screens.
- `docs/visual-qa/before/report.json`: per-screen axe, overflow and console results for the baseline.
- Full-size PNGs are git-ignored (about 15 MB per set); regenerate with `VQA_LABEL=before|after pnpm e2e -g "visual QA"`.
- `docs/visual-qa/contrast-report.json`: explicit contrast audit.
- `docs/visual-qa/logo-fidelity.png`: approved artwork vs shipped SVG, sizes and app icons.

Capture results:

| Set | Screens | Horizontal overflow | axe WCAG 2.1 A/AA violations | Console errors |
|---|---|---|---|---|
| Before (`dacf051`) | 104 | 0 | 0 | expected HTTP statuses (401 logged-out probe, 404 not-found shop) and one transient `ERR_CONNECTION_REFUSED` on a single screen (test-server hiccup) |
| After, third run | 104 | 0 | 6 on 2 screens, with realistic data (history list footer, device chips): both fixed after this capture | only the same expected HTTP statuses |

The 6 hits only appeared with realistic data (extra history pages, revoked devices); the earlier data-less runs showed 0. The fixes are covered by typecheck and the unit suite; the browser capture was **not** re-run after them (see limitations).

## Accessibility and contrast

`e2e/12-wcag-contrast.spec.ts` (independent of axe): 26 screens and states, 3,175 text elements, 0 violations at the last run (4.5:1, 3:1 for large text, disabled controls exempt), plus focus ring checks (at least 2 px, 3:1) on the customer page and both navy sidebars, and the invalid-field border colour. After the revoked-device finding the audit also accounts for inherited opacity; that stricter version has not been run in a full pass.

Token pairs (computed): navy on orange 5.41, orange-ink on paper 5.13, orange on navy 5.41, white on navy 15.97, info on white 6.46, info on navy 2.47 (hence the white sidebar ring).

## Tests

| Check | Result |
|---|---|
| Web typecheck | pass (after the final change) |
| Web unit suite | 431 / 431 pass (after the final change), also with three suites running at once |
| `e2e-ui` | 15 / 15 pass (before the last two fixes) |
| Full browser E2E | 65 / 65 pass on a disposable database and private ports (third run); the final fourth run was stopped on request, so the last fixes are not browser-verified locally |
| Production build and bundle check | pass (before the last fixes); CI runs them again |

**Unit test failures, cause.** Earlier runs showed 4 to 9 failures in queue, analytics, order-detail and admin page tests under load. Reproduced on demand by running three suites at once: Vitest's 5 s per-test timeout and Testing Library's 1 s async wait expire when 11 jsdom workers render whole pages on a busy machine (11 "Test timed out in 5000ms" plus findBy timeouts). Fix: `maxWorkers: 4`, 30 s test and hook timeouts, `asyncUtilTimeout: 5000`. The same three-at-once run then passed 431 / 431 three times, in 62 s instead of 112 s. No assertion was changed.

**Other failures seen and resolved.** `05-robustness` PWA test asserted the old manifest name (updated to PrintoutBuddy, navy theme colour, maskable icon). `03-isolation` failed once while CPU-heavy image scripts ran alongside; passes 3 / 3 alone. `04-desktop` failed once in a full run: root cause is the rate-card race above, now fixed and covered by a regression test.

## Remaining limitations

- The last accessibility fixes (devices card, history list footer) and the stricter opacity-aware contrast audit are verified by typecheck and unit tests only; browser E2E and a fresh "after" capture were skipped by request. GitHub CI runs the E2E before merge.
- Comparison sheets reflect the third capture run (see above).
- The approved PDF is raster only, so the SVG is a measured trace, not the original vector source; ask the designer for the source file if exact curves matter.
- The login pages and the Customer header use the full mark at 36 px, as in the approved lockup; the simple mark is used only for compact and loading cases.
- `docs/design/` is git-ignored (large PDFs), so the logo-fidelity script needs the PDFs locally.
