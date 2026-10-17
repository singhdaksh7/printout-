#!/usr/bin/env bash
# Migration history + schema compatibility. Run from the repo root at the development release candidate (fetch-depth 0).
# 1. Production state: migrations already on origin/main must be an unmodified prefix of the candidate's migrations.
# 2. Upgrade path: main's schema (its migrations only) + the candidate's new migrations on a disposable database, then a drift check.
# Needs: DB_ADMIN_URL (superuser URL of a DISPOSABLE postgres, ending in /postgres), psql, pnpm deps installed.
set -euo pipefail
MIG=apps/api/prisma/migrations
TMP="$(mktemp -d)"

git diff --name-status origin/main HEAD -- "$MIG" | awk '$1 != "A"' > "$TMP/nonadd"
if [ -s "$TMP/nonadd" ]; then echo "::error::applied migrations were modified, removed or renamed (migrations are forward-only):"; cat "$TMP/nonadd"; exit 1; fi
git ls-tree -d --name-only origin/main "$MIG/" | sed 's#.*/##' | sort > "$TMP/main"
git ls-tree -d --name-only HEAD "$MIG/" | sed 's#.*/##' | sort > "$TMP/head"
if comm -23 "$TMP/main" "$TMP/head" | grep -q .; then echo "::error::migrations on main are missing from the candidate"; exit 1; fi
comm -13 "$TMP/main" "$TMP/head" > "$TMP/new"
LAST_MAIN="$(tail -n1 "$TMP/main")"
while read -r m; do
  [ -z "$m" ] && continue
  [[ "$m" > "$LAST_MAIN" ]] || { echo "::error::new migration $m sorts before main's latest $LAST_MAIN"; exit 1; }
done < "$TMP/new"
echo "migration history ok: $(wc -l < "$TMP/new" | tr -d ' ') new migration(s) on top of main's $(wc -l < "$TMP/main" | tr -d ' ')"

psql "$DB_ADMIN_URL" -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS rc_upgrade' -c 'CREATE DATABASE rc_upgrade' >/dev/null
export DATABASE_URL="${DB_ADMIN_URL%/*}/rc_upgrade?schema=public"
restore() { git reset -q -- "$MIG" 2>/dev/null || true; rm -rf "$MIG"; git checkout -q HEAD -- "$MIG"; }
trap restore EXIT
rm -rf "$MIG"; git checkout -q origin/main -- "$MIG"            # production's state: only main's migrations
pnpm --filter @printout/api exec prisma migrate deploy
restore                                                           # the candidate's full migration set
pnpm --filter @printout/api exec prisma migrate deploy            # applies only the new ones, exactly as production will
pnpm --filter @printout/api exec prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
echo "upgrade from main's schema to the candidate is clean and drift-free"
