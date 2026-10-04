# Deploying Printout on one VPS

Single-host Docker Compose, no Kubernetes. Assets live in `deploy/`:

| File | Purpose |
| --- | --- |
| `deploy/docker-compose.prod.yml` | postgres, one-shot `migrate`, `api`, `worker`, `web` (nginx), `caddy` (HTTPS) |
| `deploy/Caddyfile` | TLS, HSTS, `/api/*` + `/health` + `/ready` to the API (SSE-safe), rest to the SPA |
| `deploy/env.production.example` | every env key with comments (copy to `deploy/.env.production`) |
| `deploy/deploy.sh` | build/pull, backup, migrate, up, wait for health; `bootstrap-admin`, `status` |
| `deploy/backup-db.sh`, `deploy/restore-db.sh` | metadata-only DB backups (age/gpg optional, rclone off-site) |
| `deploy/rotate-secrets.md` | rotation notes |
| `apps/api/Dockerfile`, `apps/web/Dockerfile` | multi-stage images (build context = repo root) |

Architecture: browser -> Caddy (80/443) -> `web:8080` (static SPA) or `api:3000`. Postgres and the API are only on the internal compose network. The worker is the same image as the API with `node dist/src/worker.js`.

## 1. Sizing and provider

- 1 vCPU / **2 GB RAM** / 20-40 GB disk is comfortable; 1 GB works with the memory limits in the compose file (postgres 384M, api 512M, worker 256M, caddy 128M, web 64M) plus 1-2 GB swap. Argon2 login hashing uses ~19 MB per concurrent login.
- Debian 12 / Ubuntu 22.04+ with Docker Engine + Compose v2 (`curl -fsSL https://get.docker.com | sh`).
- Pick a region near your shops. Documents are uploaded to the API and stored in R2, so the VPS needs decent upload bandwidth, not much disk.

## 2. DNS and firewall

1. Create an `A` (and `AAAA`) record: `printout.example.com` -> VPS IP. Wait until `dig +short printout.example.com` returns it (Caddy cannot get a certificate before that).
2. Firewall: allow inbound **80/tcp, 443/tcp, 443/udp** (HTTP/3) and SSH from your IP only. Example: `ufw default deny incoming && ufw allow 22/tcp && ufw allow 80,443/tcp && ufw allow 443/udp && ufw enable`.
   Docker publishes ports by editing iptables and bypasses ufw for published ports: this stack publishes only 80/443 on purpose (postgres has no `ports:`). Do not add `ports:` to other services.
3. SSH keys only, disable password login, enable unattended security upgrades.

## 3. Private storage bucket (Cloudflare R2, recommended)

1. R2 -> Create bucket `printout-documents`. Leave **public access disabled** (no `r2.dev` URL, no custom domain).
2. R2 -> Manage API tokens -> create token with **Object Read & Write**, scoped to **this bucket only**. Note Access Key ID, Secret, and the account endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
3. **CORS is not needed for uploads**: the browser PUTs the file to the Printout API (same origin, `/api/v1/public/uploads/:id/content`), which streams it to R2 server-side. Shop staff open documents through short-lived presigned GET links (navigation/iframe, not `fetch`), which also need no CORS.
4. **Lifecycle backstop (required):** bucket -> Settings -> Object lifecycle rules -> delete objects **2 days** after creation (prefix: all). The app deletes documents within 30 minutes of print / 24 hours if unprinted, and the worker retries; the lifecycle rule guarantees nothing survives if the worker is down or a delete fails permanently. Also add "abort incomplete multipart uploads after 1 day".
5. Any S3-compatible store works (Backblaze B2, AWS S3, Wasabi); set `S3_ENDPOINT/S3_REGION/S3_FORCE_PATH_STYLE` accordingly and apply the equivalent lifecycle rule.

## 4. Configure

```bash
git clone <your repo> /opt/printout && cd /opt/printout
cp deploy/env.production.example deploy/.env.production && chmod 600 deploy/.env.production
openssl rand -base64 48   # run 4x: SESSION_SECRET, CSRF_SECRET, QUOTE_SECRET, STORAGE_URL_SECRET (all different)
openssl rand -hex 24      # POSTGRES_PASSWORD (hex keeps the generated DATABASE_URL valid)
$EDITOR deploy/.env.production
```

Set at least: `DOMAIN`, `ACME_EMAIL`, `WEB_ORIGIN=https://<DOMAIN>`, `POSTGRES_PASSWORD`, the four secrets, `STORAGE_DRIVER=s3` and the five `S3_*` values. The API refuses to boot in production if `WEB_ORIGIN` is not https, secrets are shorter than 32 chars, look like placeholders (`replace`, `change-me`, `example`, `password`...), or `CSRF_SECRET == SESSION_SECRET`.

Notes on values the compose file forces: `NODE_ENV=production`, `TRUST_PROXY=true` (Caddy is the only client of the API and overwrites `X-Forwarded-For`, so rate limits and login throttling see real client IPs; never publish the API port or `TRUST_PROXY` becomes spoofable), `DATABASE_URL` (from `POSTGRES_PASSWORD`, pool of 5 connections each for api and worker). Leave `PUBLIC_API_BASE` unset (same origin). The `uploads-local` volume is only used with `STORAGE_DRIVER=local`: **not for production at scale** (single disk, lost with the server, not backed up, no lifecycle backstop). Never include it in backups.

## 5. First deploy

```bash
deploy/deploy.sh               # builds images, starts postgres, runs prisma migrate deploy, starts everything, waits for health
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<12+ char passphrase>' deploy/deploy.sh bootstrap-admin
```

`bootstrap-admin` runs `apps/api/prisma/bootstrap-admin.ts` (compiled to `dist/prisma/bootstrap-admin.js`): creates one `PLATFORM_ADMIN` with an Argon2id hash, idempotent, never touches demo data. **Do not run `db:seed` in production** (it creates demo shops with a known password). Reset later with `ADMIN_RESET_PASSWORD=1` (invalidates that user's sessions). Then log in at `https://<DOMAIN>/admin`, create shops, and hand out owner credentials.

Without a build host you can push images to a registry and set `PRINTOUT_API_IMAGE`/`PRINTOUT_WEB_IMAGE`, then `deploy/deploy.sh --pull`.

### Verify HTTPS and routing

```bash
curl -sI https://$DOMAIN | grep -i -E 'HTTP|strict-transport|content-security'      # 200 + HSTS
curl -s  https://$DOMAIN/health ; curl -s https://$DOMAIN/ready                      # {"data":{"status":"ok"}} / ready
curl -sI http://$DOMAIN | head -1                                                    # 308 redirect to https
curl -sI https://$DOMAIN/sw.js | grep -i cache-control                               # no-cache
```
Check the certificate at ssllabs.com once; HSTS is set to 1 year without `preload`.

## 6. Operations

- **Status:** `deploy/deploy.sh status`. Containers have healthchecks (api `/health`, web `/healthz`, postgres `pg_isready`); `restart: unless-stopped` brings them back after crashes/reboots (enable `docker.service` at boot).
- **Monitoring:** external uptime monitor (UptimeRobot/BetterStack, free) on `https://<DOMAIN>/ready` (checks the DB) every minute, alert by email. Also alert on disk > 80% (`df -h`) and a stale worker (see logs below).
- **Logs:** `docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml logs -f --tail=100 api` (also `worker`, `caddy`, `postgres`). json-file driver rotates at 10 MB x 3 files per container. Caddy access logs redact `token`/`sig`/`exp` query params and cookies. The worker logs `retention worker started` and per-run cleanup results as JSON.
- **Update:** `git pull && deploy/deploy.sh`. The script takes a DB backup (if the DB exists), builds, runs migrations as a one-shot job (a failing migration aborts before the app is replaced), restarts, and waits for health. Short downtime (seconds) while api restarts; open SSE streams reconnect.
- **Rollback:** migrations are **forward-only**. For a code-only regression: `git checkout <previous tag> && deploy/deploy.sh`. If the bad release included a migration that the old code cannot run against: stop api+worker, restore the pre-deploy backup (`deploy/restore-db.sh`), then deploy the old code. Always back up before releasing; prefer additive (expand/contract) migrations.
- **Secrets rotation:** `deploy/rotate-secrets.md`.
- **Disk hygiene:** `docker image prune -f` after deploys (only affects dangling images; do not run `docker system prune` on a shared host).

## 7. Backups and privacy

```bash
sudo apt install age rclone
age-keygen -o ~/printout-backup-key.txt      # keep the PRIVATE key OFF the server (password manager); put the public key in BACKUP_AGE_RECIPIENT
rclone config                                # remote e.g. r2backup -> a DIFFERENT, private bucket (R2/B2); set BACKUP_RCLONE_REMOTE=r2backup:printout-db-backups
crontab -e   # 30 2 * * * /opt/printout/deploy/backup-db.sh >> /var/log/printout-backup.log 2>&1
```

What a DB backup contains, honestly: shops, user accounts (Argon2 password hashes), pricing, orders and status history, audit log, and per-document **metadata**: customer-provided original filenames, optional customer reference/name field, page count, checksum, object key, timestamps. **Document contents are never in Postgres and never in backups**; they exist only in the private bucket and are deleted by the app within 30 minutes of printing / 24 hours unprinted (lifecycle rule backstop: 2 days). Session rows are excluded from dumps. Because filenames can themselves be personal ("Resume_Ravi_Kumar.pdf"), backups are treated as personal data: encrypt them (age/gpg), keep retention **at most 14 days** (the script caps `BACKUP_RETENTION_DAYS` at 14 locally and on the rclone remote), keep the off-site bucket private, and set a 14-day lifecycle rule on that bucket as well. If a customer erasure request arrives, the filename may persist in dumps for up to 14 days.

**Restore drill (do this before launch, then quarterly):**
```bash
export AGE_IDENTITY=~/printout-backup-key.txt
TARGET_DB=printout_restore_test deploy/restore-db.sh /var/backups/printout/printout-<stamp>.dump.age   # scratch DB, prints order count
# real recovery: docker compose ... stop api worker; deploy/restore-db.sh <file> ; deploy/deploy.sh
```

## 8. Cost estimate (INR 99 per shop per month)

| Item | Approx. monthly |
| --- | --- |
| VPS 2 vCPU / 2 GB (Hetzner CX22 ~EUR 4-5, DigitalOcean/Vultr ~USD 6-12) | INR 400-1000 |
| Cloudflare R2 (free tier: 10 GB-month, 1M writes, 10M reads, zero egress); documents live < 24 h so storage stays near 0 | INR 0 |
| Domain | ~INR 70-100 (amortised) |
| Backup bucket (R2/B2 free tier; dumps are KBs-MBs) | INR 0 |
| Total | **~INR 500-1100** |

Break-even is roughly **6-12 paying shops**; a 2 GB box should handle hundreds of small shops. Prices are estimates; check current provider pricing. R2 operations (a few per order) stay far inside the free tier at this scale.

## 9. Security checklist

- [ ] Only 80/443 open; SSH key-only; `docker ps` shows no `0.0.0.0` binding except caddy.
- [ ] `deploy/.env.production` is `chmod 600`, not in git, not in backups; secrets are unique and 48+ bytes.
- [ ] Bucket is private, token scoped to the one bucket, lifecycle rule (2 days) active, no public domain.
- [ ] `STORAGE_DRIVER=s3` (local volume is a fallback only).
- [ ] No `db:seed` run in production; demo accounts absent (`SELECT email FROM "User"`).
- [ ] HSTS present, HTTP redirects to HTTPS, certificate valid.
- [ ] Backups encrypted, off-site, retention <= 14 days, restore drill passed.
- [ ] Uptime monitor on `/ready`; unattended security upgrades on; `docker compose pull` of base images periodically (`caddy`, `nginx`, `postgres:16` minor updates).
- [ ] Postgres has no published port; `ss -tlnp` shows only 22/80/443.

## 10. Known limitations

- **Single instance.** SSE connections, login-failure throttling and rate-limit counters are in-memory per API process; do not scale `api` beyond one replica without moving them to a shared store (Redis). Restarting the API resets counters and drops SSE streams (clients reconnect).
- **Worker is a separate process** and cannot push SSE events: shop screens rely on the server `deleteAfter` countdown/refetch after worker deletions. It has no HTTP healthcheck; watch its logs (a run every `DOCUMENT_CLEANUP_INTERVAL_MINUTES`) and keep the bucket lifecycle backstop.
- Postgres is a single container on one disk: use provider snapshots plus the logical dumps; no HA/failover. Restore time is minutes, expect downtime in a disaster.
- No built-in log shipping/metrics; add Grafana Agent/Loki or a hosted uptime service if needed.
- Image builds happen on the VPS by default (needs ~2 GB free disk and a minute of CPU); use a registry (`--pull`) to avoid that.
