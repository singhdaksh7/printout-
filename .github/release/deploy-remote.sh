#!/usr/bin/env bash
# Runs ON the VPS (streamed over ssh by deploy.sh; nothing is installed there). Usage: bash -s -- <step>
# Scope: ONLY the compose project / compose file / services named in the environment. It never uses `down`, `prune`,
# `docker system`, wildcards, other compose projects, other databases, the standalone Caddy deploy script, or unrelated paths.
# Required env: APP_DIR COMPOSE_FILE COMPOSE_PROJECT ENV_FILE SERVICES MIGRATE_SERVICE RELEASE_ID RELEASE_SHA
#               MIN_FREE_PCT MIN_FREE_GIB MIN_MEM_MIB      Optional: AGE_IDENTITY (restore test of encrypted dumps), POSTGRES_SERVICE (postgres)
set -euo pipefail
set +x
for v in APP_DIR COMPOSE_FILE COMPOSE_PROJECT ENV_FILE SERVICES MIGRATE_SERVICE RELEASE_ID RELEASE_SHA; do [ -n "${!v:-}" ] || { echo "missing $v" >&2; exit 2; }; done
PG="${POSTGRES_SERVICE:-postgres}"
STATE_DIR="$APP_DIR/.release-state"; mkdir -p "$STATE_DIR"
C=(docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
die() { echo "REMOTE ERROR: $*" >&2; exit 1; }
read -ra SVC <<<"$SERVICES"
get() { local l; l="$(grep -E "^$1=" "$ENV_FILE" | tail -n1 || true)"; l="${l#*=}"; l="${l%$'\r'}"; l="${l#\"}"; l="${l%\"}"; printf '%s' "$l"; }
g() { git -C "$APP_DIR" "$@"; }

step_preflight() {
  [ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout"
  [ -f "$COMPOSE_FILE" ] && [ -f "$ENV_FILE" ] || die "compose file or env file missing"
  grep -qi traefik "$COMPOSE_FILE" || die "$COMPOSE_FILE does not reference traefik: refusing (this release uses the existing Traefik compose configuration)"
  case "$(basename "$COMPOSE_FILE")" in *caddy*|docker-compose.prod.yml) die "refusing the Caddy/standalone compose file";; esac
  "${C[@]}" config -q >/dev/null || die "compose config does not validate"
  [ -z "$(g status --porcelain --untracked-files=no)" ] || die "server checkout has local modifications; refusing to overwrite"
  local free_pct free_gib mem
  read -r free_pct free_gib < <(df -P --output=pcent,avail "$APP_DIR" | awk 'NR==2{gsub("%","",$1); printf "%d %d\n", 100-$1, $2/1048576}')
  mem="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
  echo "disk free: ${free_pct}% (${free_gib} GiB); mem available: ${mem} MiB; load: $(cut -d' ' -f1-3 /proc/loadavg)"
  [ "$free_pct" -ge "$MIN_FREE_PCT" ] && [ "$free_gib" -ge "$MIN_FREE_GIB" ] || die "not enough free disk"
  [ "$mem" -ge "$MIN_MEM_MIB" ] || die "not enough available memory"
  docker info >/dev/null 2>&1 || die "docker is not reachable"
  # Rollback readiness: remember exactly what runs now, and prove the previous images still exist.
  g rev-parse HEAD > "$STATE_DIR/previous-sha"
  "${C[@]}" ps --format '{{.Service}} {{.Image}}' > "$STATE_DIR/previous-images"
  docker ps --format '{{.Names}}' | sort > "$STATE_DIR/containers-before" # every running container, other projects included
  [ -s "$STATE_DIR/previous-images" ] || die "no running containers in project $COMPOSE_PROJECT: nothing to roll back to; refusing a first-time deploy"
  while read -r svc img; do docker image inspect "$img" >/dev/null 2>&1 || die "previous image $img for $svc is not present locally: rollback not possible"; done < "$STATE_DIR/previous-images"
  [ -n "$(get BACKUP_RCLONE_REMOTE)" ] || die "BACKUP_RCLONE_REMOTE is not set in the env file: no off-server backup copy configured"
  [ -n "$(get BACKUP_AGE_RECIPIENT)$(get BACKUP_GPG_RECIPIENT)" ] || die "backups are not encrypted (BACKUP_AGE_RECIPIENT / BACKUP_GPG_RECIPIENT unset)"
  echo "previous release: $(cat "$STATE_DIR/previous-sha")"
  echo "preflight ok"
}

step_fetch() {
  g fetch --no-tags origin "refs/tags/release-$RELEASE_ID:refs/tags/release-$RELEASE_ID" "+refs/heads/main:refs/remotes/origin/main"
  [ "$(g rev-parse "release-$RELEASE_ID^{commit}")" = "$RELEASE_SHA" ] || die "tag release-$RELEASE_ID does not point at the approved SHA"
  g merge-base --is-ancestor "$RELEASE_SHA" origin/main || die "approved SHA is not on main"
  echo "approved SHA verified on main"
}

step_backup() {
  export ENV_FILE COMPOSE_FILE_PATH="$COMPOSE_FILE" COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT"
  bash "$APP_DIR/deploy/backup-db.sh" 2>&1 | tee "$STATE_DIR/backup.log"
  grep -q "uploaded + verified on" "$STATE_DIR/backup.log" || die "backup was not verified on the off-server remote"
  local dir newest; dir="$(get BACKUP_DIR)"; dir="${dir:-/var/backups/printout}"
  newest="$(find "$dir" -maxdepth 1 -type f -name 'printout-????????T??????Z.dump*' | sort | tail -n1)"
  [ -n "$newest" ] && [ -s "$newest" ] || die "no backup file found after backup"
  echo "$newest" > "$STATE_DIR/backup-file"; echo "backup: $newest"
}

step_restore_test() {
  local f; f="$(cat "$STATE_DIR/backup-file")"
  export ENV_FILE COMPOSE_FILE_PATH="$COMPOSE_FILE" COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT" TARGET_DB=printout_restore
  [ -z "${AGE_IDENTITY:-}" ] || export AGE_IDENTITY
  bash "$APP_DIR/deploy/restore-db.sh" "$f" | tee "$STATE_DIR/restore.log"
  grep -q "restore into 'printout_restore' complete" "$STATE_DIR/restore.log" || die "restore test did not complete"
}

step_checkout_build() {
  g checkout --detach "$RELEASE_SHA" >/dev/null 2>&1
  [ "$(g rev-parse HEAD)" = "$RELEASE_SHA" ] || die "checkout did not land on the approved SHA"
  "${C[@]}" build "${SVC[@]}"
  echo "built $RELEASE_SHA"
}

step_rehearse() {
  # Run the release's migrations against the RESTORED COPY (printout_restore), never the live database.
  local url scratch; url="$(get DATABASE_URL)"; [ -n "$url" ] || die "DATABASE_URL not found in the env file"
  scratch="$(printf '%s' "$url" | sed -E 's#(/)printout(\?|$)#\1printout_restore\2#')"
  [ "$scratch" != "$url" ] || die "could not derive the scratch database URL (expected database name 'printout')"
  "${C[@]}" run --rm --no-deps -e "DATABASE_URL=$scratch" "$MIGRATE_SERVICE"
  "${C[@]}" exec -T "$PG" psql -U printout -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS printout_restore WITH (FORCE)' >/dev/null
  echo "migration rehearsal on the restored copy succeeded; scratch database dropped"
}

step_deploy() {
  "${C[@]}" run --rm --no-deps "$MIGRATE_SERVICE"
  "${C[@]}" up -d --no-deps "${SVC[@]}"
  local s cid st
  for s in "${SVC[@]}"; do
    st=none
    for _ in $(seq 1 60); do
      cid="$("${C[@]}" ps -q "$s" || true)"
      st="none"; [ -z "$cid" ] || st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")"
      if [ "$st" = healthy ] || [ "$st" = running ]; then break; fi
      sleep 3
    done
    if [ "$st" != healthy ] && [ "$st" != running ]; then "${C[@]}" logs --tail=40 "$s" >&2 || true; die "service $s is $st"; fi
  done
  echo "deployed $RELEASE_SHA"
}

step_verify() {
  [ "$(g rev-parse HEAD)" = "$RELEASE_SHA" ] || die "server checkout is not on the approved SHA"
  docker ps --format '{{.Names}}' | sort > "$STATE_DIR/containers-after"
  if comm -23 "$STATE_DIR/containers-before" "$STATE_DIR/containers-after" | grep -q .; then
    echo "containers that were running before and are not now:" >&2; comm -23 "$STATE_DIR/containers-before" "$STATE_DIR/containers-after" >&2
    die "a container stopped during the deploy"
  fi
  echo "all previously running containers are still running"
}

step_new_migrations() {
  g diff --name-only --diff-filter=A "$(cat "$STATE_DIR/previous-sha")" "$RELEASE_SHA" -- apps/api/prisma/migrations | wc -l
}

step_rollback_code() {
  local prev; prev="$(cat "$STATE_DIR/previous-sha")"
  g checkout --detach "$prev" >/dev/null 2>&1
  "${C[@]}" up -d --no-deps --build "${SVC[@]}"
  echo "code rolled back to $prev (database NOT restored: migrations are forward-only)"
}

"step_${1:?step}"
