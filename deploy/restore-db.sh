#!/usr/bin/env bash
# Restore a dump made by backup-db.sh into the running Postgres container.
#   deploy/restore-db.sh <file.dump|file.dump.age|file.dump.gpg> [--yes]
# Env for decryption: AGE_IDENTITY=/path/to/age-key.txt (age) ; gpg uses your keyring.
# To rehearse safely use a scratch target:  TARGET_DB=printout_restore_test deploy/restore-db.sh <file>
# Restoring into the live DB (default) DROPS and recreates all objects: stop api+worker first.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.prod.yml")
FILE="${1:-}"; CONFIRM="${2:-}"
TARGET_DB="${TARGET_DB:-printout}"

[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "usage: $0 <backup-file> [--yes]" >&2; exit 1; }
[[ "$TARGET_DB" =~ ^[a-zA-Z0-9_]+$ ]] || { echo "bad TARGET_DB" >&2; exit 1; }

if [ "$TARGET_DB" = "printout" ] && [ "$CONFIRM" != "--yes" ]; then
  echo "This will OVERWRITE the live 'printout' database. Stop api/worker first:" >&2
  echo "  ${COMPOSE[*]} stop api worker" >&2
  read -r -p "Type 'restore' to continue: " ans
  [ "$ans" = "restore" ] || { echo "aborted"; exit 1; }
fi

decrypt() {
  case "$FILE" in
    *.age) age -d -i "${AGE_IDENTITY:?set AGE_IDENTITY to your age private key file}" "$FILE" ;;
    *.gpg) gpg --batch -d "$FILE" ;;
    *) cat "$FILE" ;;
  esac
}

if [ "$TARGET_DB" != "printout" ]; then
  "${COMPOSE[@]}" exec -T postgres psql -U printout -d postgres -c "DROP DATABASE IF EXISTS \"$TARGET_DB\"" -c "CREATE DATABASE \"$TARGET_DB\""
fi

decrypt | "${COMPOSE[@]}" exec -T postgres pg_restore -U printout -d "$TARGET_DB" --clean --if-exists --no-owner --exit-on-error
echo "restore into '$TARGET_DB' complete."
"${COMPOSE[@]}" exec -T postgres psql -U printout -d "$TARGET_DB" -Atc 'SELECT count(*) AS orders FROM "Order"'
[ "$TARGET_DB" = "printout" ] && echo "Now start the app:  ${COMPOSE[*]} up -d   (migrate re-checks the schema)"
exit 0
