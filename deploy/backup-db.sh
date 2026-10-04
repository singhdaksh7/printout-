#!/usr/bin/env bash
# Logical backup of the Printout Postgres DB (METADATA ONLY).
#   bash deploy/backup-db.sh                 # run from anywhere; reads deploy/.env.production (or ENV_FILE=...)
# Cron (daily 02:30):  30 2 * * * /usr/bin/env bash /opt/printout/deploy/backup-db.sh >> /var/log/printout-backup.log 2>&1
#
# SCOPE (privacy invariant): this script dumps ONLY the Postgres database via `pg_dump` inside the postgres
# container. Customer DOCUMENT CONTENT (the private R2/S3 bucket or the `uploads-local` Docker volume) is NEVER
# included, never synced, and must never be added to any backup workflow: documents live at most 30 minutes after
# printing / 24 h unprinted. Do not point rclone, restic, tar or snapshots at the bucket or at /data/uploads.
#
# What a dump contains: shops, users (argon2 hashes), pricing, orders, order status history, audit log, and per-document
# METADATA incl. customer-provided original filenames, optional customer reference, object keys and checksums.
# Session rows are excluded (no live login tokens in backups). Treat dumps as personal data: encrypt, keep <= 14 days.
#
# Settings (environment, or KEY=value lines in the env file; environment wins):
#   BACKUP_DIR                (default /var/backups/printout)
#   BACKUP_RETENTION_DAYS     (default 14, hard cap 14)
#   BACKUP_AGE_RECIPIENT      age public key  -> <name>.dump.age   (fails if `age` is missing)
#   BACKUP_GPG_RECIPIENT      gpg recipient   -> <name>.dump.gpg   (fails if `gpg`/key is missing)
#   BACKUP_RCLONE_REMOTE      e.g. r2backup:printout-db-backups  (a DIFFERENT, private bucket; DB dumps only)
#   BACKUP_MIN_BYTES          sanity floor for the dump size (default 2048)
#   COMPOSE_PROJECT_NAME      override the compose project (testing); ENV_FILE override the env file
# Exit codes: 0 ok, 1 failure (nothing is pruned and no partial file is left behind on failure).
set -euo pipefail
set +x # never trace: nothing here may echo credentials

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH:-$DEPLOY_DIR/docker-compose.prod.yml}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE_PATH")

die() { echo "backup-db: ERROR: $*" >&2; exit 1; }
warn() { echo "backup-db: WARNING: $*" >&2; }

command -v docker >/dev/null 2>&1 || die "docker not found in PATH"
[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE (copy deploy/env.production.example, or set ENV_FILE=...)"

# Read one KEY from the env file without `source`-ing it (values may contain shell metacharacters).
get() {
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" | tail -n1 || true)"
  line="${line#*=}"; line="${line%$'\r'}"
  case "$line" in \"*\") line="${line#\"}"; line="${line%\"}";; \'*\') line="${line#\'}"; line="${line%\'}";; esac
  printf '%s' "$line"
}
BACKUP_DIR="${BACKUP_DIR:-$(get BACKUP_DIR)}"; BACKUP_DIR="${BACKUP_DIR:-/var/backups/printout}"
RETENTION="${BACKUP_RETENTION_DAYS:-$(get BACKUP_RETENTION_DAYS)}"; RETENTION="${RETENTION:-14}"
AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-$(get BACKUP_AGE_RECIPIENT)}"
GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-$(get BACKUP_GPG_RECIPIENT)}"
RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-$(get BACKUP_RCLONE_REMOTE)}"
MIN_BYTES="${BACKUP_MIN_BYTES:-2048}"

case "$RETENTION" in ''|*[!0-9]*) die "BACKUP_RETENTION_DAYS must be a positive integer (got '$RETENTION')";; esac
[ "$RETENTION" -ge 1 ] || die "BACKUP_RETENTION_DAYS must be >= 1"
if [ "$RETENTION" -gt 14 ]; then warn "BACKUP_RETENTION_DAYS capped at 14 (privacy policy)"; RETENTION=14; fi
case "$MIN_BYTES" in ''|*[!0-9]*) die "BACKUP_MIN_BYTES must be an integer";; esac
[ -n "$AGE_RECIPIENT" ] && [ -n "$GPG_RECIPIENT" ] && die "set only one of BACKUP_AGE_RECIPIENT / BACKUP_GPG_RECIPIENT"
if [ -n "$AGE_RECIPIENT" ]; then command -v age >/dev/null 2>&1 || die "BACKUP_AGE_RECIPIENT is set but 'age' is not installed (apt install age)"; fi
if [ -n "$GPG_RECIPIENT" ]; then
  command -v gpg >/dev/null 2>&1 || die "BACKUP_GPG_RECIPIENT is set but 'gpg' is not installed"
  gpg --batch --list-keys "$GPG_RECIPIENT" >/dev/null 2>&1 || die "gpg recipient '$GPG_RECIPIENT' not found in the keyring"
fi
if [ -n "$RCLONE_REMOTE" ]; then
  command -v rclone >/dev/null 2>&1 || die "BACKUP_RCLONE_REMOTE is set but 'rclone' is not installed"
  case "$RCLONE_REMOTE" in *uploads*|*documents*) die "BACKUP_RCLONE_REMOTE='$RCLONE_REMOTE' looks like a document bucket; backups must go to a separate DB-dump bucket";; esac
fi

# The compose file needs its required variables (POSTGRES_PASSWORD, DOMAIN, ...): fail early with compose's own message.
"${COMPOSE[@]}" config -q >/dev/null || die "docker compose could not parse the stack with $ENV_FILE (missing required variable?)"
"${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx postgres || die "postgres container is not running (start it: ${COMPOSE[*]} up -d postgres)"

umask 077
mkdir -p "$BACKUP_DIR"
WORK="$(mktemp -d "$BACKUP_DIR/.tmp-backup.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
trap 'exit 130' INT TERM

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="printout-$STAMP.dump"
RAW="$WORK/$NAME"

# -Fc = custom format (compressed; restore with pg_restore). --no-owner: restores into any role.
# The Session table is dumped schema-only so no live login tokens end up in a backup.
echo "backup-db: dumping database 'printout'..."
"${COMPOSE[@]}" exec -T postgres pg_dump -U printout -d printout -Fc -Z 6 --no-owner --exclude-table-data='"Session"' > "$RAW" \
  || die "pg_dump failed"

# Validate BEFORE encrypting/keeping: size floor, readable TOC, and the core tables are present.
SIZE="$(wc -c < "$RAW" | tr -d ' ')"
[ "$SIZE" -ge "$MIN_BYTES" ] || die "dump is only $SIZE bytes (< $MIN_BYTES); refusing to keep it"
TOC="$("${COMPOSE[@]}" exec -T postgres pg_restore --list < "$RAW")" || die "pg_restore --list could not read the dump (corrupt?)"
# Full read (decompresses every data block, catching mid-file corruption); output discarded.
"${COMPOSE[@]}" exec -T postgres pg_restore -f - < "$RAW" > /dev/null || die "dump failed the full read-back check (corrupt?)"
for t in Shop User Order Document; do
  printf '%s\n' "$TOC" | grep -Eq "TABLE( DATA)? public \"?$t\"? " || die "dump TOC lacks table \"$t\"; refusing to keep it"
done
PREV="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'printout-????????T??????Z.dump*' 2>/dev/null | sort | tail -n1 || true)"
if [ -n "$PREV" ]; then
  PREV_SIZE="$(wc -c < "$PREV" | tr -d ' ')"
  # Only comparable when both are plain (encrypted size differs slightly); loose 50% rule.
  if [ "$AGE_RECIPIENT$GPG_RECIPIENT" = "" ] && [ "${PREV%.dump}" != "$PREV" ] && [ $((SIZE * 2)) -lt "$PREV_SIZE" ]; then
    warn "dump ($SIZE B) is less than half of the previous one ($PREV_SIZE B); check for data loss"
  fi
fi

# Encrypt (if requested) or keep plain. Output is written under a temp name and renamed only when complete.
if [ -n "$AGE_RECIPIENT" ]; then
  FINAL_NAME="$NAME.age"; age -r "$AGE_RECIPIENT" -o "$WORK/$FINAL_NAME" "$RAW" || die "age encryption failed"
elif [ -n "$GPG_RECIPIENT" ]; then
  FINAL_NAME="$NAME.gpg"; gpg --batch --yes --trust-model always -r "$GPG_RECIPIENT" -o "$WORK/$FINAL_NAME" -e "$RAW" || die "gpg encryption failed"
else
  FINAL_NAME="$NAME"
  warn "no BACKUP_AGE_RECIPIENT/BACKUP_GPG_RECIPIENT set: backup is stored UNENCRYPTED (file mode 600)"
fi
[ -s "$WORK/$FINAL_NAME" ] || die "final backup file is empty"
OUT="$BACKUP_DIR/$FINAL_NAME"
mv "$WORK/$FINAL_NAME" "$OUT"
chmod 600 "$OUT" 2>/dev/null || true
echo "backup-db: written $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, validated: full read-back ok, core tables present)"

# Off-server copy (DB dumps only), verified by size+hash before anything is pruned there.
if [ -n "$RCLONE_REMOTE" ]; then
  rclone copyto "$OUT" "${RCLONE_REMOTE%/}/$FINAL_NAME" --immutable || die "rclone upload failed"
  rclone check "$BACKUP_DIR" "${RCLONE_REMOTE%/}" --include "$FINAL_NAME" --one-way >/dev/null 2>&1 || die "rclone check failed: remote copy does not match $FINAL_NAME"
  echo "backup-db: uploaded + verified on $RCLONE_REMOTE"
else
  warn "no BACKUP_RCLONE_REMOTE set; this backup exists only on this server"
fi

# Retention. Only files that exactly match our naming pattern are ever deleted (strict ?-glob on the timestamp).
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'printout-????????T??????Z.dump' -o -name 'printout-????????T??????Z.dump.age' -o -name 'printout-????????T??????Z.dump.gpg' \) \
  -mtime +"$((RETENTION - 1))" -print -delete | sed 's/^/backup-db: pruned local /'
if [ -n "$RCLONE_REMOTE" ]; then
  rclone delete "${RCLONE_REMOTE%/}" --min-age "${RETENTION}d" --max-depth 1 \
    --include 'printout-????????T??????Z.dump' --include 'printout-????????T??????Z.dump.age' --include 'printout-????????T??????Z.dump.gpg' \
    || warn "remote pruning failed (non-fatal)"
fi
echo "backup-db: done (retention ${RETENTION}d)"
