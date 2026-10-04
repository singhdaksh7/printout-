#!/usr/bin/env bash
# Deploy / update the Printout stack on this server.
#   deploy/deploy.sh                 build (or pull), migrate, start, wait for health
#   deploy/deploy.sh --pull          pull prebuilt images (PRINTOUT_*_IMAGE in env) instead of building
#   deploy/deploy.sh bootstrap-admin ADMIN_EMAIL=... ADMIN_PASSWORD=... (inline env) -> first platform admin
#   deploy/deploy.sh status
# Migrations are forward-only: a backup is taken first when the DB already exists.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.prod.yml")
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy deploy/env.production.example)" >&2; exit 1; }

CMD="${1:-deploy}"

wait_healthy() {
  local svc="$1" tries=60 cid status
  while [ "$tries" -gt 0 ]; do
    cid="$("${COMPOSE[@]}" ps -q "$svc" || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")"
      [ "$status" = "healthy" ] || [ "$status" = "running" ] && return 0
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
  bootstrap-admin)
    : "${ADMIN_EMAIL:?set ADMIN_EMAIL inline}"; : "${ADMIN_PASSWORD:?set ADMIN_PASSWORD inline}"
    "${COMPOSE[@]}" run --rm --no-deps -T -e ADMIN_EMAIL -e ADMIN_PASSWORD -e ADMIN_NAME -e ADMIN_RESET_PASSWORD \
      api node dist/prisma/bootstrap-admin.js ;;
  deploy|--pull)
    if [ "$CMD" = "--pull" ]; then
      "${COMPOSE[@]}" pull api web caddy postgres
    else
      "${COMPOSE[@]}" build api web
    fi
    # Pre-migration backup (skipped on the very first deploy when postgres has never run).
    if [ -n "$("${COMPOSE[@]}" ps -q postgres 2>/dev/null)" ]; then
      echo "taking pre-deploy backup..."; "$DEPLOY_DIR/backup-db.sh" || echo "WARNING: backup failed" >&2
    fi
    "${COMPOSE[@]}" up -d postgres
    wait_healthy postgres
    "${COMPOSE[@]}" run --rm migrate          # one-shot `prisma migrate deploy`; non-zero exit aborts the deploy
    "${COMPOSE[@]}" up -d --remove-orphans
    wait_healthy api
    wait_healthy web
    wait_healthy caddy
    echo "deployed. checking /ready through the stack..."
    DOMAIN_VAL="$(grep -E '^DOMAIN=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
    if curl -fsS --max-time 10 "https://$DOMAIN_VAL/ready" >/dev/null 2>&1; then echo "OK https://$DOMAIN_VAL/ready"; else
      echo "NOTE: https://$DOMAIN_VAL/ready not reachable yet (DNS/certificate may still be issuing). Check: ${COMPOSE[*]} logs caddy" >&2
    fi
    "${COMPOSE[@]}" ps ;;
  *) echo "usage: $0 [deploy|--pull|bootstrap-admin|status]" >&2; exit 1 ;;
esac
