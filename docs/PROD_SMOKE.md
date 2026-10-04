# Production smoke test

`deploy/smoke.mjs` (Node >= 20, no dependencies, run from any machine with network access to the site) checks that a deployed Printout stack is wired correctly. Verified locally against the hardened compose stack over HTTPS (Caddy internal CA): 28/28 checks including write mode.

```bash
# 1. Read-only (default). Safe against production: only GETs, plus logins (sessions are created, then logged out).
BASE_URL=https://printout.example.com \
SHOP_SLUG=smoke-shop SHOP_EMAIL=owner@smoke.example SHOP_PASSWORD='...' \
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' \
node deploy/smoke.mjs

# 2. Write mode (explicit opt-in): ONE tiny test order through the whole lifecycle.
SMOKE_WRITE=1 BASE_URL=... SHOP_SLUG=smoke-shop SHOP_EMAIL=... SHOP_PASSWORD='...' node deploy/smoke.mjs
```

Credentials are read from the environment only (put them in your shell, not in a file in the repo). Exit code 0 = every executed check passed.

## What it checks

| Mode | Check |
| --- | --- |
| read | homepage 200 HTML; `manifest.webmanifest` 200; `sw.js` not cached; `/health` ok; `/ready` ok (DB); security headers (nosniff, CSP, Referrer-Policy, no proxy `Server`, HSTS on https); HTTP redirects to HTTPS (`HTTP_BASE_URL` to override); unknown API route is a 404 JSON without internals; `/.env`, `/.data`, `/deploy/...`, `/uploads/` are not served |
| read (needs `SHOP_SLUG`) | public shop API returns the public shape (no ids / owner data) |
| read (needs shop creds) | shop login + `/auth/session` (and the login belongs to `SHOP_SLUG`); queue read; a mutation **without** CSRF header is rejected (403); SSE `/shop/events`: 200, `text/event-stream`, not compressed, first bytes (`retry:`) within `SSE_WAIT_SECONDS` (default 8) |
| read (needs admin creds) | admin login (role PLATFORM_ADMIN); dashboard read; admin cannot use shop endpoints |
| **write** | generates a 1-page PDF; upload initiate, raw PUT, complete (page count 1), quote (B&W, single, 1 copy), order, shop sees it in the queue, NEW to ACCEPTED to PRINTING, `document-access` URL downloads bytes identical to the upload, print-confirmation, then asserts `deleteAfter - printedAt == retentionMinutes` (30 by default; taken from the public shop API, override `EXPECT_RETENTION_MINUTES`) and that the customer tracking page shows `deleteAfter` |

Other env: `SMOKE_INSECURE=1` (self-signed/internal-CA TLS, local only), `SKIP_HSTS=1` (plain-http local stacks), `SSE_WAIT_SECONDS`, `HTTP_BASE_URL`.

## Write mode: rules

- It prints a warning and refuses to run without `SHOP_SLUG` + shop credentials. **Never point it at a customer shop**: create a dedicated shop (e.g. `smoke-shop`) in the admin panel with an active B&W / single-sided / A4 pricing rule and accepting orders. The order stays in the shop's history (PRINTED) and counts in its analytics.
- It uploads a real (tiny) object to the production bucket. The worker must delete it about 30 minutes after the print confirmation: **re-check after about 35 minutes** that the document shows as deleted (shop order detail: deletion state `DELETED`; the bucket holds no object for it; `docker compose ... logs worker` shows the cleanup). This proves worker + R2 deletion on the real infrastructure and is not automated.
- Do not run it on a schedule against production; run it after a deploy and after secret/bucket changes.

## Manual checklist (things the script cannot see)

- [ ] Browser: open `https://<DOMAIN>/p/<slug>` on a phone, upload a real PDF, quote, order; the tracking page counts down after the shop prints it.
- [ ] Browser: install the PWA ("Add to Home screen"), reopen offline: the shell loads and API calls fail gracefully.
- [ ] Shop page on desktop: SSE live update (a new order appears without refresh); close the laptop lid and reopen: it reconnects.
- [ ] Certificate valid (ssllabs.com once), HSTS present, `http://` redirects.
- [ ] `docker ps` shows only Caddy bound to 80/443; `ss -tlnp` shows only 22/80/443.
- [ ] Bucket: no public access; lifecycle rule (2 days) present; object count returns to about 0 after the smoke order is deleted.
- [ ] A backup ran (`ls -l /var/backups/printout`) and a restore drill into a scratch DB succeeded (`docs/DEPLOYMENT.md`, restore drill).
- [ ] Uptime monitor on `/ready` is green and alerts by email.
