# Rotating secrets

Generate new values on the server: `openssl rand -base64 48` (secrets), `openssl rand -hex 24` (DB password).
After editing `deploy/.env.production`, apply with `deploy/deploy.sh` (or `docker compose ... up -d api worker`).

| Secret | Effect of rotating | Procedure |
| --- | --- | --- |
| `SESSION_SECRET` | Also the fallback source of the quote key. | Update, restart api+worker. Sessions are DB-token based, so users stay logged in unless you also change CSRF_SECRET. |
| `CSRF_SECRET` | CSRF tokens are HMAC(secret, sessionId): all clients' tokens become invalid; the web app re-fetches `/auth/session`. | Update, restart api. Users may see one failed mutation, then recover on reload. Must differ from SESSION_SECRET. |
| `QUOTE_SECRET` | In-flight price quotes (TTL 10 min) become invalid. | Rotate any time; customers re-quote. |
| `STORAGE_URL_SECRET` | Outstanding signed local URLs and upload tokens (minutes) become invalid. | Rotate any time; no effect with STORAGE_DRIVER=s3 except upload tokens. |
| `POSTGRES_PASSWORD` | DB auth. | `docker compose exec postgres psql -U printout -c "ALTER USER printout PASSWORD '<new hex>'"`, then update the env file, then `up -d api worker` (migrate re-runs). Env change alone does NOT change an existing volume's password. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Bucket access. | In Cloudflare create a NEW token scoped to the bucket, update env, restart api+worker, verify an upload+delete, then revoke the old token. |
| Admin password | Platform admin login. | `ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_RESET_PASSWORD=1 deploy/deploy.sh bootstrap-admin` (also invalidates that user's sessions). |
| Backup age key | Decrypting old dumps. | Keep old private keys until the last dump encrypted to them has aged out (14 days). |

To force-logout everyone: `docker compose ... exec postgres psql -U printout -c 'UPDATE "Session" SET "invalidatedAt" = now() WHERE "invalidatedAt" IS NULL'`.

Rotate immediately if an env file, backup, or R2 token may have leaked. Never commit `deploy/.env.production`.
