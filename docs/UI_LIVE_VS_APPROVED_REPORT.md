# Live UI (7f6b36a) vs approved design and `development`: visual comparison

Date: 2026-10-17. Method: the same Playwright capture (36 screenshots: customer, shop, admin; 1440 px and 390 px) was run against the deployed commit `7f6b36a` and against `development`, on a disposable database with identical seed data, and compared with `docs/design/2.pdf` (admin) and `docs/design/3.pdf` (shop).

## Findings

| Area | Live `7f6b36a` | `development` | Decision |
|---|---|---|---|
| Colour system | purple accent, hand-written `sh-*`/`ad-*` CSS with inline styles | navy sidebar, orange primary, shared `pb-*` components, matches the PDFs | keep `development` |
| Shop queue list | card rows; chips overlap the Print and Save buttons at 1440 px | accessible data table, no overlap | keep `development` |
| Shop navigation | Queue, Pricing, QR, Analytics, Settings | adds Devices, Rate card, Staff and Reports (soon) | keep `development` |
| Queue summary strip | four tiles from first-page list lengths (best effort) with a hard-coded "+12%" trend | none | **ported, rebuilt** (below) |
| Greeting header, global search, notification bell | present, not wired to anything | none (not in the approved PDFs) | not ported |
| "Grow PrintoutBuddy" upsell card | present | none (not in the approved PDFs) | not ported |
| Admin dashboard | custom KPI grid | `StatTile`, `Card`, `KeyValueList` on shared components | keep `development` |

## What was changed

`apps/web/src/shop/QueuePage.tsx`: a summary strip above the queue, as in the approved queue design (docs/design/3.pdf p7), fed by the existing `GET /shop/analytics` response: waiting for print (`newPrintRequests`), orders today, pages today (pages x copies, excluding cancelled and expired) and prints started today (`printsInitiated`). It refreshes with the queue (realtime event and 45 s timer). If analytics is unavailable the strip is not shown and the queue works as before. Four tiles in a row on desktop, 2x2 on phones (hints hidden below 600 px). No routes, API, authentication, printing, cancellation, pricing or retention behaviour changed. The approved "Printer: ready" tile is not included: it needs per-shop device presence, which has no summary endpoint yet.

## Not touched

Order History, Admin Security, email, Android and Windows Agent work.
