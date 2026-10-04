#!/usr/bin/env bash
# Logical backup of the Printout Postgres DB (metadata only; customer documents are NOT in Postgres).
#   deploy/backup-db.sh                 # run from anywhere; uses deploy/.env.production
# Cron example (daily 02:30):  30 2 * * * /opt/printout/deploy/backup-db.sh >> /var/log/printout-backup.log 2>&1
#
# What is in a dump: shops, users (argon2 hashes), pricing, orders, order status history, audit log,
# and per-document METADATA incl. customer-provided original filenames, optional customer reference,
# object keys and checksums. Document CONTENT lives only in the private R2/S3 bucket and is never backed up.
# Session rows are excluded (no live login tokens in backups).
# Retention is capped at 14 days (BACKUP_RETENTION_DAYS cannot exceed it). Prefer encryption (age/gpg).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.prod.yml")

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
# Only read the backup-related keys (the file may contain characters unsafe to `source`).
get() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }
BACKUP_DIR="${BACKUP_DIR:-$(get BACKUP_DIR)}"; BACKUP_DIR="${BACKUP_DIR:-/var/backups/printout}"
RETENTION="${BACKUP_RETENTION_DAYS:-$(get BACKUP_RETENTION_DAYS)}"; RETENTION="${RETENTION:-14}"
AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-$(get BACKUP_AGE_RECIPIENT)}"
GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-$(get BACKUP_GPG_RECIPIENT)}"
RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-$(get BACKUP_RCLONE_REMOTE)}"

case "$RETENTION" in ''|*[!0-9]*) echo "BACKUP_RETENTION_DAYS must be an integer" >&2; exit 1;; esac
if [ "$RETENTION" -gt 14 ]; then echo "BACKUP_RETENTION_DAYS capped at 14 (privacy policy)" >&2; RETENTION=14; fi

umask 077
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/printout-$STAMP.dump"

# -Fc = custom format, already compressed (restore with pg_restore). Written to a temp name first.
dump() {
  "${COMPOSE[@]}" exec -T postgres pg_dump -U printout -d printout -Fc -Z 6 --no-owner --exclude-table-data='"Session"'
}

if [ -n "$AGE_RECIPIENT" ]; then
  OUT="$OUT.age"; dump | age -r "$AGE_RECIPIENT" > "$OUT.partial"
elif [ -n "$GPG_RECIPIENT" ]; then
  OUT="$OUT.gpg"; dump | gpg --batch --yes --trust-model always -r "$GPG_RECIPIENT" -e > "$OUT.partial"
else
  echo "WARNING: BACKUP_AGE_RECIPIENT/BACKUP_GPG_RECIPIENT not set; backup is stored unencrypted (disk perms 600)." >&2
  dump > "$OUT.partial"
fi
[ -s "$OUT.partial" ] || { echo "backup is empty, aborting" >&2; rm -f "$OUT.partial"; exit 1; }
mv "$OUT.partial" "$OUT"
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"

# Local retention.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'printout-*.dump*' -mtime +"$((RETENTION - 1))" -print -delete

# Off-server copy (R2/B2 via rclone), with the same retention.
if [ -n "$RCLONE_REMOTE" ]; then
  rclone copy "$OUT" "$RCLONE_REMOTE" --immutable
  rclone delete "$RCLONE_REMOTE" --min-age "${RETENTION}d" --include 'printout-*.dump*'
  echo "uploaded to $RCLONE_REMOTE (pruned >${RETENTION}d)"
else
  echo "NOTE: no BACKUP_RCLONE_REMOTE set; this backup exists only on this server." >&2
fi
