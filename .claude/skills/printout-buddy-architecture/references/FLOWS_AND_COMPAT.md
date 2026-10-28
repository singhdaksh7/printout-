# Customer and shop flows; Windows Agent and Android compatibility

## CURRENT_PRODUCTION flows

Guest customer: scan QR (`/p/<slug>`), view shop and availability (server hours engine `domain/hours.ts`), upload, get a quote (quote token), place order, track by token. No customer account exists.

Shop owner: sign in (password, Google, phone), live queue and filters, accept, print (print-now, print-confirmation), ready, collected; cancel; history and CSV; rate card (per-sheet rules); hours; QR poster; devices; notifications via durable `ShopNotification` and one SSE stream. The shop is free and ACTIVE immediately after onboarding.

Windows Agent / device: pair with a code, send printers, claim `DevicePrintJob`s, download via device routes, report progress, heartbeat. Distinct from `ShopDevice` (Android) only in client kind; both use `pbd_` credentials. `PrintAgent`/`Printer`/`PrintJob` are additive, currently unused tables; do not start using them without a separate reviewed design.

## PROPOSED customer flows (not existing)

Customer sign-in, profile with location, nearby search, shop detail, authenticated upload and order, own order history, cancel while NEW/ACCEPTED, UTR submission, review after COLLECTED, customer notifications. The guest QR flow stays; authenticated and guest ordering share one pricing/validation function.

## Compatibility checklist for any change touching orders, statuses or auth

- Android: tolerates unknown fields; unknown enum values must not crash before a new value (REJECTED) is introduced; refresh/logout contract unchanged.
- Windows Agent: reads `/device/*` only; never change those response shapes; a status change must not re-queue or replay a physical print; PRINTED is set only by print confirmation.
- Web queue/tracking/history/CSV/analytics switch on `OrderStatus`; update all or none.
- Retention worker: do not delete a document of a non-terminal order or active job; keep deletion idempotent.
- Hours: `afterHoursPolicy = BLOCK` rejects new submissions with 409 `SHOP_CLOSED`; never blocks tracking or shop-side handling.
