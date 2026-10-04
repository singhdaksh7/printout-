# Deploying Printout on one VPS: first-deployment runbook

Single-host Docker Compose, no Kubernetes. Browser -> Caddy (80/443, automatic HTTPS) -> `web` (nginx, static SPA) or `api` (Fastify). `worker` (same image as the API) deletes expired documents. Postgres is on an internal-only network. Documents live in a **private R2/S3 bucket**, never on the VPS disk and never in backups.

| File | Purpose |
| --- | --- |
| `deploy/docker-compose.prod.yml` | postgres, one-shot `migrate`, `api`, `worker`, `web`, `caddy` (hardened: read-only fs, `cap_drop: ALL`, no-new-privileges, limits, log rotation, 3 networks) |
| `deploy/Caddyfile` | TLS, HSTS, `/api/*` + `/health` + `/ready` to the API (SSE-safe, streamed uploads), rest to the SPA |
| `deploy/env.production.example` | every env key (matches `apps/api/src/config.ts`) |
| `deploy/deploy.sh` | `deploy` (build, backup, migrate, up), `--pull`, `migrate`, `bootstrap-admin`, `status`, `logs` |
| `deploy/backup-db.sh`, `deploy/restore-db.sh` | metadata-only DB backups / restores (age or gpg, rclone off-site) |
| `deploy/smoke.mjs` | post-deploy smoke test, see `docs/PROD_SMOKE.md` |
| `deploy/rotate-secrets.md` | secret rotation |

Convention: run every `deploy/*.sh` as `bash deploy/<script>.sh` (no `chmod +x` needed; if you prefer `./deploy/x.sh`, run `chmod +x deploy/*.sh` once). Run everything from the repository root.

Legend: **[verified]** = executed against the real stack/images locally (Docker Desktop, Caddy internal CA); **[static]** = reviewed but only provable on a real VPS.

---

## 1. VPS prerequisites

- Debian 12 / Ubuntu 22.04+, 1 vCPU / **2 GB RAM** (1 GB works with 1-2 GB swap), 20-40 GB disk, public IPv4 (IPv6 optional).
- Limits in the compose file: postgres 384M, api 512M, worker 256M, caddy 128M, web 64M.
- Outbound HTTPS must work (Let's Encrypt, R2).
- A domain you control (`printout.example.com` below) and an email for ACME expiry notices.

## 2. DNS

Create `A` (and `AAAA` if you have IPv6) records: `printout.example.com` -> VPS IP. Wait until `dig +short printout.example.com` returns it. Caddy cannot obtain a certificate before this resolves. If the domain is on Cloudflare, set the record to **DNS only** (grey cloud) for the first issuance.

## 3. Firewall and SSH

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install ufw unattended-upgrades
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp   # 443/udp = HTTP/3
sudo ufw enable
```

Use SSH keys only (`PasswordAuthentication no` in `/etc/ssh/sshd_config`). Docker edits iptables directly and bypasses ufw for **published** ports: this stack publishes only Caddy's 80/443 [verified: `docker ps` of the test stack shows only caddy with host ports]. Never add `ports:` to other services.

## 4. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker            # restart policies need Docker to start at boot
sudo usermod -aG docker "$USER" && newgrp docker
docker compose version                         # Compose v2 required
```

## 5. Get the release

```bash
sudo mkdir -p /opt/printout && sudo chown "$USER" /opt/printout
git clone <your repo url> /opt/printout && cd /opt/printout
git checkout <release tag or commit>
```

(Alternative with no build on the VPS: build and push images from CI, set `PRINTOUT_API_IMAGE` / `PRINTOUT_WEB_IMAGE` in the env file, and use `bash deploy/deploy.sh --pull`.)

## 6. Cloudflare R2 bucket (private document storage)

1. R2 -> **Create bucket** `printout-documents`. Leave **public access disabled**: no `r2.dev` URL, no custom domain.
2. R2 -> Manage API tokens -> create a token with **Object Read & Write**, scoped to **this bucket only**. Record the Access Key ID, Secret Access Key and your account endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (region `auto`).
3. **Lifecycle backstop (required):** bucket -> Settings -> Object lifecycle rules -> delete objects **2 days** after creation (all prefixes); add "abort incomplete multipart uploads after 1 day". The app deletes documents within 30 minutes of printing / 24 hours unprinted and the worker retries; the rule guarantees nothing survives if the worker is down.
4. **No CORS is needed**: browsers PUT files to `https://<DOMAIN>/api/v1/public/uploads/...` (same origin; the API streams to R2). Shop staff open documents via short-lived presigned GET links (navigation/iframe).
5. Any S3-compatible store works (Backblaze B2, AWS S3, Wasabi): set `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE` accordingly and create the equivalent lifecycle rule.

Not verified locally [static]: real R2 connectivity, signed-URL behaviour against R2, lifecycle rule. The S3 driver is unit-tested with mocks; local-volume storage was used for the end-to-end runs. Run the write-mode smoke test (step 15) as the first real R2 test.

## 7. Production environment file

```bash
cp deploy/env.production.example deploy/.env.production && chmod 600 deploy/.env.production
for i in 1 2 3 4; do openssl rand -base64 48; done   # SESSION_SECRET, CSRF_SECRET, QUOTE_SECRET, STORAGE_URL_SECRET (all different)
openssl rand -hex 24                                  # POSTGRES_PASSWORD (hex keeps the generated DATABASE_URL valid)
$EDITOR deploy/.env.production
```

Set at least: `DOMAIN`, `ACME_EMAIL`, `WEB_ORIGIN=https://<DOMAIN>`, `POSTGRES_PASSWORD`, the four secrets, `STORAGE_DRIVER=s3` and the five `S3_*` values (`S3_FORCE_PATH_STYLE=true`). The API **refuses to start** in production (listing each bad key, never values) if: `WEB_ORIGIN` is not https or points at localhost; a secret is shorter than 32 chars, looks like a placeholder, or two secrets are equal; `SSE_HEARTBEAT_MS` > 25000; `STORAGE_DRIVER=local` without `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true`; or neither `TRUST_PROXY` nor `TRUST_PROXY_CIDRS` is set (the compose file sets `TRUST_PROXY_CIDRS=loopback,linklocal,uniquelocal`) [verified].

Values forced by the compose file (do not set them in the env file): `NODE_ENV=production`, `TRUST_PROXY_CIDRS`, `API_PORT`, `DATABASE_URL` (built from `POSTGRES_PASSWORD`, pool of 5 per process). Leave `PUBLIC_API_BASE` unset (same origin). `UPLOAD_MAX_BYTES` (default 50 MiB, ceiling 100 MiB) and Caddy's `MAX_REQUEST_BODY` (default 53477376 = 50 MiB + 1 MiB) must move together: `deploy.sh` refuses to deploy if `MAX_REQUEST_BODY < UPLOAD_MAX_BYTES + 1048576`.

The env file is passed to api/worker/migrate as-is (so they also see `POSTGRES_PASSWORD` and `BACKUP_*`; they are unused there). Keep it `chmod 600`, never commit it, never back it up with the database dumps.

## 8. Build, migrate, start

```bash
bash deploy/deploy.sh          # build api+web, (backup if a DB exists), start postgres, run migrations, start everything, wait for health
bash deploy/deploy.sh status   # all services Up (healthy); `migrate` shows Exited (0)
```

Order inside the script (always the same): **backup -> migrate -> up**. `migrate` is the one-shot job `docker compose ... run --rm migrate` = `prisma migrate deploy`; if it fails the deploy aborts and the old containers keep running [verified: a no-op `migrate deploy` and the full flow]. Do **not** run `db:seed` in production (it creates demo accounts; the compiled seed script is not even shipped in the image).

## 9. First platform admin

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<12+ char passphrase>' bash deploy/deploy.sh bootstrap-admin
```

Runs `node dist/prisma/bootstrap-admin.js` inside a one-shot api container [verified]: creates one `PLATFORM_ADMIN` with an Argon2id hash, idempotent, never creates demo data. Later reset: add `ADMIN_RESET_PASSWORD=1` (invalidates that user's sessions). Then log in at `https://<DOMAIN>/admin`, create shops, hand out owner credentials.

## 10. Verify HTTPS, headers, health

```bash
D=printout.example.com
curl -sI http://$D | head -3                                       # 308 redirect to https [verified locally]
curl -sI https://$D | grep -i -E '^HTTP|strict-transport|content-security|x-content-type'   # 200 + HSTS (max-age 1y, includeSubDomains) [verified]
curl -s https://$D/health ; echo ; curl -s https://$D/ready ; echo       # {"data":{"status":"ok"}} / {"data":{"status":"ready"}}
curl -sI https://$D/sw.js | grep -i cache-control                  # no-cache
```

`/health` is liveness only (no DB; used by Docker healthchecks). `/ready` runs `SELECT 1` and is what external monitors should watch. A real Let's Encrypt certificate [static]: check `docker compose ... logs caddy` for "certificate obtained successfully", and run an ssllabs.com test once. HSTS is 1 year without `preload`.

## 11. SSE

SSE has no extra proxy config: Caddy runs `flush_interval -1`, no `encode` on `/api/*`, and no write timeout. Check through the real domain (log in first and keep the cookie):

```bash
curl -s -c /tmp/j -X POST https://$D/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"<shop email>","password":"<pw>"}' -o /dev/null
timeout 30 curl -sN -b /tmp/j -i https://$D/api/v1/shop/events      # headers + "retry: 3000", then ": ping" after ~25 s
```

[verified over HTTPS through Caddy: `Content-Type: text/event-stream`, `retry: 3000` immediately, `: ping` after 25 s.] The API holds SSE subscribers in memory: **run exactly one `api` replica**.

## 12. Upload test and smoke test (also the first real R2 test)

In the admin panel create a dedicated shop `smoke-shop` with an owner and an active A4 B&W single-sided pricing rule. Then, from your laptop:

```bash
BASE_URL=https://$D SHOP_SLUG=smoke-shop SHOP_EMAIL=... SHOP_PASSWORD=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node deploy/smoke.mjs                 # read-only
SMOKE_WRITE=1 BASE_URL=https://$D SHOP_SLUG=smoke-shop SHOP_EMAIL=... SHOP_PASSWORD=... node deploy/smoke.mjs   # one tiny order (smoke shop only!)
```

See `docs/PROD_SMOKE.md`. Large uploads: Caddy streams the body (not buffered) and returns a clean `413` above `MAX_REQUEST_BODY` [verified: 40 MiB and exactly 50 MiB PUT -> 200; 60 MiB -> 413 from Caddy for both Content-Length and chunked bodies; a slow chunked PUT reached the API while the client was still sending].

## 13. Worker verification

```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml logs --tail=20 worker
```

You should see `retention worker started` and, as documents expire, JSON lines with the cleanup results every `DOCUMENT_CLEANUP_INTERVAL_MINUTES`. About 35 minutes after the write-mode smoke test, confirm its document is deleted (shop order detail shows it deleted; the bucket is empty). The worker has no HTTP healthcheck: restart policy covers crashes; the bucket lifecycle rule covers a stalled worker. A one-off run: `docker compose ... run --rm --no-deps worker node dist/src/worker.js --once` [verified].

## 14. Backups (metadata only)

The database holds shops, accounts (Argon2 hashes), pricing, orders, audit log and per-document **metadata** (customer filenames, optional reference, checksums, keys). **Customer document content is never in Postgres and must never be added to any backup workflow**: do not snapshot/sync the R2 bucket or the `uploads-local` volume. Sessions are excluded from dumps. Backups are personal data: encrypt, keep **at most 14 days**.

```bash
sudo apt -y install age rclone
age-keygen -o ~/printout-backup-key.txt          # keep the PRIVATE key OFF the server (password manager); note the printed public key
rclone config                                    # remote r2backup -> a DIFFERENT private bucket, e.g. printout-db-backups (14-day lifecycle rule)
# in deploy/.env.production:
#   BACKUP_DIR=/var/backups/printout   BACKUP_RETENTION_DAYS=14
#   BACKUP_AGE_RECIPIENT=age1...       BACKUP_RCLONE_REMOTE=r2backup:printout-db-backups
sudo mkdir -p /var/backups/printout && sudo chown "$USER" /var/backups/printout
bash deploy/backup-db.sh                         # first backup now
crontab -e   # 30 2 * * * cd /opt/printout && /usr/bin/env bash deploy/backup-db.sh >> /var/log/printout-backup.log 2>&1
```

Script behaviour [verified on Linux (Alpine container against a throwaway Postgres) and Git Bash on Windows]: required settings checked up front; `pg_dump -Fc` via `docker compose exec -T postgres`; dump validated (size floor, full `pg_restore` read-back, core tables present) **before** encryption; temp files `umask 077` + cleanup trap; fails if age/gpg/rclone is requested but missing; with rclone the upload is verified with `rclone check`; pruning only deletes files named `printout-YYYYMMDDTHHMMSSZ.dump[.age|.gpg]` older than the retention (local and remote); a failed backup prunes nothing. `pre-restore-*.dump` safety dumps are never pruned automatically: delete them after an incident.

**Restore drill (do this before launch, then quarterly):**

```bash
export AGE_IDENTITY=~/printout-backup-key.txt
bash deploy/restore-db.sh /var/backups/printout/printout-<stamp>.dump.age    # restores into scratch DB 'printout_restore'; prints row counts
# compare with: docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml exec -T postgres psql -U printout -d printout -Atc 'select count(*) from "Order"'
```

Row counts matched the source in every verified run (Session is intentionally 0). The live DB is untouched unless `--overwrite-production` is passed (see step 16).

## 15. Monitoring

External uptime monitor (UptimeRobot / BetterStack, free) on `https://<DOMAIN>/ready` every minute with email alerts; alert when disk > 80% (`df -h`). `bash deploy/deploy.sh status`; logs: `bash deploy/deploy.sh logs api` (also `worker`, `caddy`, `postgres`). json-file driver rotates at 10 MB x 3 per container. Caddy access logs redact `token`/`sig`/`exp` query parameters, cookies and Authorization/CSRF headers.

## 16. Updates, migrations, rollback

**Deploy order is always: backup -> migrate -> up.** `bash deploy/deploy.sh` does all three (`git pull && bash deploy/deploy.sh`): it takes a backup first (and **aborts** if the backup fails; `SKIP_BACKUP=1` only if you backed up another way), runs `docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml run --rm migrate` (= `prisma migrate deploy`), then `up -d`. Only migrations are one-shot; a failing migration leaves the old containers running.

- Migrations are **forward-only** (no down migrations). Prefer additive (expand/contract) changes so the previous release still runs against the new schema.
- **Code-only rollback:** `git checkout <previous tag> && bash deploy/deploy.sh`.
- **Rollback of a release that included a migration the old code cannot run against:** restore the pre-deploy backup.
  ```bash
  docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml stop api worker
  bash deploy/restore-db.sh /var/backups/printout/<pre-deploy dump> --overwrite-production      # asks you to type 'restore production'; takes a safety dump of the current DB first
  git checkout <previous tag> && bash deploy/deploy.sh
  ```
  `--overwrite-production` refuses to run while api/worker are up, validates the archive before dropping anything, then drops and recreates the DB [verified]. Sessions are not in backups: everyone logs in again.
- Secrets rotation: `deploy/rotate-secrets.md`. Disk hygiene: `docker image prune -f` after deploys (never `docker system prune` on a shared host).

## 17. Cost estimate (INR 99 per shop per month)

| Item | Approx. monthly |
| --- | --- |
| VPS 2 vCPU / 2 GB (Hetzner CX22 ~EUR 4-5, DigitalOcean/Vultr ~USD 6-12) | INR 400-1000 |
| Cloudflare R2 (free tier 10 GB-month, zero egress; documents live < 24 h) | INR 0 |
| Domain | ~INR 70-100 |
| Backup bucket (dumps are KBs-MBs) | INR 0 |
| Total | **~INR 500-1100** |

Break-even is roughly 6-12 paying shops. Prices are estimates.

## 18. Security checklist

- [ ] Only 80/443 (+22) open; `docker ps` shows no `0.0.0.0` binding except caddy; `ss -tlnp` shows only 22/80/443.
- [ ] `deploy/.env.production` is `chmod 600`, not in git; secrets unique, 48+ bytes.
- [ ] Bucket private, token scoped to the one bucket, 2-day lifecycle rule active, no public domain.
- [ ] `STORAGE_DRIVER=s3` (local volume is a fallback only).
- [ ] No demo accounts: `docker compose ... exec postgres psql -U printout -c 'SELECT email FROM "User"'`.
- [ ] HSTS present, HTTP redirects to HTTPS, certificate valid.
- [ ] Backups encrypted, off-site, retention <= 14 days, restore drill passed, **no document storage in any backup**.
- [ ] Uptime monitor on `/ready`; unattended security upgrades on; base images re-pulled monthly (`caddy`, `nginx`, `postgres:16`, `node`).

## 19. What was verified where

| Area | Status |
| --- | --- |
| Images build from the lockfile (`--frozen-lockfile`), API image 834 MB -> 674 MB, non-root, tini, HEALTHCHECK `/health`, `prisma migrate deploy`, `bootstrap-admin`, `worker --once`, login, upload -> complete -> quote -> order -> print-confirm | **verified** (local Docker) |
| Hardened compose (read-only fs, `cap_drop: ALL`, no-new-privileges, internal DB network, no published ports except caddy) boots and passes the smoke test with local storage | **verified** |
| Caddy: HTTP->HTTPS redirect, HSTS, SSE over HTTPS incl. heartbeat, streamed uploads (40/50 MiB OK, 60 MiB 413), client `X-Forwarded-For` overwritten, no CSP violations in Chromium (PWA service worker, QR canvases, iframe preview) | **verified** with Caddy's internal CA on `printout.localhost` |
| Backups/restore (plain, age, gpg, rclone to a local-dir remote, corrupt/truncated/empty files, production-overwrite guards) | **verified** |
| Public DNS + Let's Encrypt issuance, HTTP/3, real R2 (put/head/presign/delete, lifecycle), real-IP logging behind the real internet, memory behaviour on a 1-2 GB VPS, ufw, unattended upgrades, off-site rclone to R2/B2 | **static / only verifiable on the real VPS** |
| Real printers and devices | `docs/REAL_PRINTER_CHECKLIST.md` (manual) |

## 20. Known limitations

- **Single API instance.** SSE subscribers, login-failure throttling and rate-limit counters are in memory per API process; do not scale `api` beyond one replica without a shared store (Redis). Restarting the API drops SSE streams (clients reconnect) and resets counters.
- The worker is a separate process and cannot push SSE events: shop screens rely on the server `deleteAfter` countdown and refetching.
- Postgres is one container on one disk: combine provider snapshots with the logical dumps; no HA. Restore time is minutes.
- No built-in log shipping/metrics; add Grafana Agent/Loki or a hosted uptime service if needed.
- Image builds happen on the VPS by default (about 2 GB free disk, a few minutes of CPU); use a registry (`--pull`) to avoid that.
- Dependency advisories: `docs/DEPENDENCIES.md`.
