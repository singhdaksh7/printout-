#!/usr/bin/env bash
# Deploy / update the Printout stack on this server.  Invoke with bash (no chmod needed):  bash deploy/deploy.sh
#   deploy.sh                 build images, backup, migrate, start, wait for health   (same as `deploy`)
#   deploy.sh --pull          pull prebuilt images (PRINTOUT_*_IMAGE in the env file) instead of building
#   deploy.sh migrate         only run `prisma migrate deploy` (one-shot job)
#   deploy.sh bootstrap-admin first platform admin; pass ADMIN_EMAIL / ADMIN_PASSWORD inline in the environment
#   deploy.sh status | logs [service]
# Order is always: backup -> migrate -> up. Migrations are FORWARD-ONLY; rollback = restore the pre-deploy backup.
# Env: ENV_FILE (default deploy/.env.production), SKIP_BACKUP=1 (only if you took a backup another way).
set -euo pipefail
set +x

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
export PRINTOUT_ENV_FILE="$ENV_FILE" # the compose file's env_file for api/worker/migrate
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.prod.yml")

die() { echo "deploy: ERROR: $*" >&2; exit 1; }
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE (copy deploy/env.production.example and fill it in)"
get() { local l; l="$(grep -E "^$1=" "$ENV_FILE" | tail -n1 || true)"; l="${l#*=}"; printf '%s' "${l%$'\r'}"; }

CMD="${1:-deploy}"

preflight() {
  "${COMPOSE[@]}" config -q >/dev/null || die "compose file does not validate with $ENV_FILE (missing required variable?)"
  local mode perms; perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
  if [ -n "$perms" ] && [ "${perms: -2}" != "00" ]; then echo "deploy: WARNING: $ENV_FILE is mode $perms; run: chmod 600 $ENV_FILE" >&2; fi
  mode="$(get STORAGE_DRIVER)"; mode="${mode:-local}"
  if [ "$mode" = "local" ] && [ "$(get ALLOW_LOCAL_STORAGE_IN_PRODUCTION)" != "true" ]; then
    echo "deploy: WARNING: STORAGE_DRIVER=local; production should use STORAGE_DRIVER=s3 (private R2 bucket)" >&2
  fi
  # Caddy's request body cap must leave headroom above the API's per-upload cap (+1 MiB for multipart/headers).
  local up max; up="$(get UPLOAD_MAX_BYTES)"; up="${up:-52428800}"; max="$(get MAX_REQUEST_BODY)"; max="${max:-53477376}"
  case "$up$max" in *[!0-9]*|'') die "UPLOAD_MAX_BYTES / MAX_REQUEST_BODY must be integers";; esac
  [ "$max" -ge $((up + 1048576)) ] || die "MAX_REQUEST_BODY ($max) must be >= UPLOAD_MAX_BYTES + 1048576 ($((up + 1048576)))"
}

wait_healthy() {
  local svc="$1" tries=60 cid status
  while [ "$tries" -gt 0 ]; do
    cid="$("${COMPOSE[@]}" ps -q "$svc" || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")"
      if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then return 0; fi
    fi
    tries=$((tries - 1)); sleep 3
  done
  echo "service $svc did not become healthy; logs:" >&2
  "${COMPOSE[@]}" logs --tail=50 "$svc" >&2 || true
  return 1
}

case "$CMD" in
  status)
    "${COMPOSE[@]}" ps ;;
  logs)
    shift || true; "${COMPOSE[@]}" logs -f --tail=100 "$@" ;;
  migrate)
    preflight
    "${COMPOSE[@]}" up -d postgres; wait_healthy postgres
    "${COMPOSE[@]}" run --rm migrate ;;
  bootstrap-admin)
    : "${ADMIN_EMAIL:?set ADMIN_EMAIL inline, e.g. ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... bash deploy/deploy.sh bootstrap-admin}"
    : "${ADMIN_PASSWORD:?set ADMIN_PASSWORD inline (12+ characters)}"
    "${COMPOSE[@]}" run --rm --no-deps -T -e ADMIN_EMAIL -e ADMIN_PASSWORD -e ADMIN_NAME -e ADMIN_RESET_PASSWORD \
      api node dist/prisma/bootstrap-admin.js ;;
  deploy|--pull)
    preflight
    if [ "$CMD" = "--pull" ]; then
      "${COMPOSE[@]}" pull api web caddy postgres
    else
      "${COMPOSE[@]}" build api web
    fi
    # Pre-migration backup. Skipped only on the very first deploy (no postgres container yet). A failed backup ABORTS:
    # migrations are forward-only, so the backup is the rollback path.
    if [ -n "$("${COMPOSE[@]}" ps -q postgres 2>/dev/null)" ] && [ "${SKIP_BACKUP:-0}" != "1" ]; then
      echo "deploy: taking pre-deploy backup..."
      ENV_FILE="$ENV_FILE" bash "$DEPLOY_DIR/backup-db.sh" || die "pre-deploy backup failed; fix it (or SKIP_BACKUP=1 if you backed up manually) and retry"
    fi
    "${COMPOSE[@]}" up -d postgres
    wait_healthy postgres
    "${COMPOSE[@]}" run --rm migrate          # one-shot `prisma migrate deploy`; non-zero exit aborts the deploy
    "${COMPOSE[@]}" up -d --remove-orphans
    wait_healthy api
    wait_healthy web
    wait_healthy caddy
    echo "deploy: stack is up. Checking /ready through Caddy..."
    DOMAIN_VAL="$(get DOMAIN)"; HTTPS_PORT_VAL="$(get HTTPS_PORT)"
    URL="https://$DOMAIN_VAL${HTTPS_PORT_VAL:+:$HTTPS_PORT_VAL}/ready"
    if curl -fsS --max-time 10 "$URL" >/dev/null 2>&1; then echo "OK $URL"; else
      echo "NOTE: $URL not reachable yet (DNS/certificate may still be issuing). Check: ${COMPOSE[*]} logs caddy" >&2
    fi
    "${COMPOSE[@]}" ps ;;
  *) echo "usage: bash $0 [deploy|--pull|migrate|bootstrap-admin|status|logs [service]]" >&2; exit 1 ;;
esac
