#!/usr/bin/env bash
# Restore a dump made by backup-db.sh (METADATA only; customer documents are not part of any backup).
#
#   Rehearsal (safe, default):   bash deploy/restore-db.sh <file>                     -> scratch DB 'printout_restore'
#   Named scratch DB:            TARGET_DB=printout_drill bash deploy/restore-db.sh <file>
#   Real recovery (DESTRUCTIVE): bash deploy/restore-db.sh <file> --overwrite-production [--yes]
#
# <file> = *.dump | *.dump.age | *.dump.gpg.   Decryption: AGE_IDENTITY=/path/to/age-key.txt (age); gpg uses your keyring.
# Other env: ENV_FILE (default deploy/.env.production), COMPOSE_PROJECT_NAME, BACKUP_DIR (safety dump location).
#
# Safety rules:
#  * The default target is a scratch database; the live 'printout' DB is only touched with --overwrite-production.
#  * Production overwrite also requires: api + worker stopped, a typed confirmation (or --yes), and first takes a
#    safety dump of the current DB (pre-restore-*.dump in BACKUP_DIR; skip with --no-safety-dump).
#  * The dump is decrypted to a private temp file and validated with `pg_restore --list` BEFORE anything is dropped.
#  * Restoring Session rows is not needed: sessions are not in backups, everyone must log in again.
set -euo pipefail
set +x

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH:-$DEPLOY_DIR/docker-compose.prod.yml}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE_PATH")
PROD_DB="printout"

die() { echo "restore-db: ERROR: $*" >&2; exit 1; }
usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" >&2; exit 1; }

FILE=""; OVERWRITE_PROD=0; YES=0; SAFETY=1
for arg in "$@"; do
  case "$arg" in
    --overwrite-production) OVERWRITE_PROD=1 ;;
    --yes) YES=1 ;;
    --no-safety-dump) SAFETY=0 ;;
    -h|--help) usage ;;
    -*) die "unknown option $arg" ;;
    *) [ -z "$FILE" ] || die "only one backup file may be given"; FILE="$arg" ;;
  esac
done
[ -n "$FILE" ] || usage
[ -f "$FILE" ] || die "backup file not found: $FILE"
[ -s "$FILE" ] || die "backup file is empty: $FILE"

TARGET_DB="${TARGET_DB:-printout_restore}"
[[ "$TARGET_DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "TARGET_DB must match ^[a-z_][a-z0-9_]*\$ (got '$TARGET_DB')"
if [ "$TARGET_DB" = "$PROD_DB" ] && [ "$OVERWRITE_PROD" -ne 1 ]; then
  die "TARGET_DB=$PROD_DB is the live database; pass --overwrite-production if you really mean it"
fi
if [ "$OVERWRITE_PROD" -eq 1 ]; then TARGET_DB="$PROD_DB"; fi

command -v docker >/dev/null 2>&1 || die "docker not found in PATH"
[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE"
case "$FILE" in
  *.age) command -v age >/dev/null 2>&1 || die "'age' is not installed"; [ -n "${AGE_IDENTITY:-}" ] && [ -f "${AGE_IDENTITY:-}" ] || die "set AGE_IDENTITY to your age private key file" ;;
  *.gpg) command -v gpg >/dev/null 2>&1 || die "'gpg' is not installed" ;;
esac
"${COMPOSE[@]}" config -q >/dev/null || die "docker compose could not parse the stack with $ENV_FILE"
"${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx postgres || die "postgres container is not running"
psql_admin() { "${COMPOSE[@]}" exec -T postgres psql -U printout -d postgres -v ON_ERROR_STOP=1 "$@"; }

umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/printout-restore.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM

# 1. Decrypt to a private temp file and validate it before touching any database.
PLAIN="$WORK/restore.dump"
case "$FILE" in
  *.age) age -d -i "$AGE_IDENTITY" -o "$PLAIN" "$FILE" || die "age decryption failed" ;;
  *.gpg) gpg --batch --yes -o "$PLAIN" -d "$FILE" || die "gpg decryption failed" ;;
  *) cp "$FILE" "$PLAIN" ;;
esac
TOC="$("${COMPOSE[@]}" exec -T postgres pg_restore --list < "$PLAIN")" || die "not a readable pg_dump custom-format archive (corrupt or wrong file); nothing was changed"
"${COMPOSE[@]}" exec -T postgres pg_restore -f - < "$PLAIN" > /dev/null || die "archive is corrupt (full read-back failed); nothing was changed"
printf '%s\n' "$TOC" | grep -Eq 'TABLE( DATA)? public "?Order"? ' || die "archive has no \"Order\" table; refusing to restore"
echo "restore-db: archive OK ($(printf '%s\n' "$TOC" | grep -c 'TABLE DATA') data sets), target database: $TARGET_DB"

# 2. Production overwrite guard rails.
if [ "$TARGET_DB" = "$PROD_DB" ]; then
  RUNNING="$("${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -E '^(api|worker)$' || true)"
  [ -z "$RUNNING" ] || die "stop these first: ${COMPOSE[*]} stop api worker   (running: $(echo "$RUNNING" | tr '\n' ' '))"
  if [ "$YES" -ne 1 ]; then
    echo "This will DROP and recreate the LIVE '$PROD_DB' database from $FILE." >&2
    read -r -p "Type 'restore production' to continue: " ans || die "aborted (no confirmation given; use --yes for non-interactive runs)"
    [ "$ans" = "restore production" ] || die "aborted"
  fi
  if [ "$SAFETY" -eq 1 ]; then
    SAFE_DIR="${BACKUP_DIR:-/var/backups/printout}"; mkdir -p "$SAFE_DIR"
    SAFE="$SAFE_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump"
    "${COMPOSE[@]}" exec -T postgres pg_dump -U printout -d "$PROD_DB" -Fc --no-owner --exclude-table-data='"Session"' > "$SAFE" \
      || { rm -f "$SAFE"; die "safety dump of the current database failed (use --no-safety-dump to skip)"; }
    echo "restore-db: safety dump of current state: $SAFE (UNENCRYPTED, delete it after the incident)"
  fi
fi

# 3. Recreate the target and restore into it (fresh DB: no --clean needed, so no partial overlay on old objects).
psql_admin -c "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$TARGET_DB\"" >/dev/null
"${COMPOSE[@]}" exec -T postgres pg_restore -U printout -d "$TARGET_DB" --no-owner --exit-on-error < "$PLAIN" \
  || die "pg_restore failed; database '$TARGET_DB' is in an undefined state"
echo "restore-db: restore into '$TARGET_DB' complete. Row counts:"
"${COMPOSE[@]}" exec -T postgres psql -U printout -d "$TARGET_DB" -Atc \
  "SELECT 'Shop='||(SELECT count(*) FROM \"Shop\")||' User='||(SELECT count(*) FROM \"User\")||' Order='||(SELECT count(*) FROM \"Order\")||' Document='||(SELECT count(*) FROM \"Document\")||' Session='||(SELECT count(*) FROM \"Session\")"
if [ "$TARGET_DB" = "$PROD_DB" ]; then
  echo "restore-db: now run  bash $DEPLOY_DIR/deploy.sh   (migrate re-checks the schema, then starts api/worker)."
else
  echo "restore-db: scratch database kept. Drop it when done:  ${COMPOSE[*]} exec -T postgres psql -U printout -d postgres -c 'DROP DATABASE \"$TARGET_DB\"'"
fi
