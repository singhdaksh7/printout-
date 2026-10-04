# Real-device / real-printer checklist

Manual acceptance on physical hardware (cannot be automated). Use a smoke/test shop and a real PDF of 3-5 pages (mixed text and an image, with at least one visibly different page so page selection is obvious). Record every result in the table at the end.

## Setup

- Customer devices: one Android phone (Chrome) and one iPhone (Safari). Shop device: Windows PC with Chrome, a physical printer set as the default, A4 paper loaded.
- Shop owner logged in at `/shop`; the shop QR code (`/shop/qr`) printed or shown on a second screen.
- Retention is `PRINT_RETENTION_MINUTES=30` (the public shop API reports `retentionMinutes`).

## Steps

1. **Scan and upload.** Scan the QR with each phone. Upload the real PDF over mobile data (not Wi-Fi) at least once. Check the progress and the page count.
2. **Options.** Place an order for each variant and check the price shown matches the shop's pricing:
   - B&W, single-sided, 1 copy, all pages
   - Colour (if the printer supports it)
   - Duplex (if supported)
   - Custom pages (e.g. `1-2,4`): only those pages print
   - Multiple copies (e.g. 3): the printer dialog copies match and the total price scales
3. **Shop receives.** The order appears on the shop screen within a few seconds without a refresh (SSE). Accept it, then press **Start printing**.
4. **Chrome PDF viewer print.** Open the document from the order (new tab or in-page preview), use Chrome's PDF viewer print (Ctrl+P), choose the physical printer and the same options (colour/B&W, duplex, pages, copies), and print.
5. **Verify the paper.** Pages, order, colour mode, sides and copy count match what the customer chose. Text is sharp and nothing is cropped.
6. **Manual confirmation.** Only after the paper is physically in your hand press **Confirm printed successfully** (and confirm in the dialog). The app never assumes success.
7. **Retention.** After confirming, the order shows the 30-minute countdown on the shop screen and on the customer's tracking page. At zero the document disappears (viewer says it is no longer available; the direct URL returns 410) and the bucket object is gone within about a minute of expiry.
8. **Reprint.** Within the 30 minutes press **Reprint** and print again; the countdown is **not** extended or reset.
9. **Mark ready / collected.** Complete the order lifecycle; the customer tracking page follows.

## Failure cases (must NOT confirm automatically)

- [ ] Cancel the Chrome print dialog: the order stays PRINTING, no countdown starts, nothing is deleted. Print again and it still works.
- [ ] Printer out of paper or offline, the job fails or is cancelled in the Windows queue: the shop does not press Confirm; nothing changes.
- [ ] Close the tab midway and reopen the order: state is unchanged; **Start printing** is still available and idempotent.
- [ ] Open the document link after expiry or after cancelling the order: refused (410), no content.
- [ ] Customer uploads a password-protected PDF, a 0-byte file, a file over 50 MB, a photo (JPEG/PNG) and a renamed `.txt`: each gets a clear error or is accepted as designed (images count as 1 page).
- [ ] Network drops during upload (airplane mode on/off): the upload can be retried; no duplicate orders.

## Results

| # | Scenario | Device / printer | Pass/Fail | Notes (price, pages, quality, timing) |
| - | --- | --- | --- | --- |
| 1 | Android upload over mobile data | | | |
| 2 | iPhone upload | | | |
| 3 | B&W single, all pages | | | |
| 4 | Colour | | | |
| 5 | Duplex | | | |
| 6 | Custom pages | | | |
| 7 | Multiple copies | | | |
| 8 | Shop confirms after paper in hand | | | |
| 9 | 30-minute countdown, deletion, 410 afterwards | | | |
| 10 | Reprint within retention (countdown unchanged) | | | |
| 11 | Cancelled print dialog does NOT confirm | | | |
| 12 | Printer failure does NOT confirm | | | |
| 13 | Password-protected / empty / oversize / non-PDF handled | | | |
| 14 | Retry after network drop, no duplicate order | | | |

Sign-off: tester ______________  date ____________  build/commit ____________
