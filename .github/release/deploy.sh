#!/usr/bin/env bash
# Phase 4 orchestrator (runs on the GitHub runner, inside the protected `production` environment).
# Env (variables): VPS_HOST VPS_USER VPS_APP_DIR VPS_COMPOSE_FILE VPS_COMPOSE_PROJECT VPS_ENV_FILE VPS_DEPLOY_SERVICES VPS_MIGRATE_SERVICE PUBLIC_URLS
# Env (secrets):   VPS_SSH_KEY  VPS_KNOWN_HOSTS (pinned host key line(s); no trust-on-first-use)   Optional: VPS_AGE_IDENTITY (path on the server)
# Input: RELEASE_SHA. Any missing item stops the run with a report; nothing is guessed.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ID="$(jq -r .releaseId "$DIR/config.json")"; EXPECTED_HOST="$(jq -r .deploy.expectedHost "$DIR/config.json")"
missing=(); for v in VPS_HOST VPS_USER VPS_APP_DIR VPS_COMPOSE_FILE VPS_COMPOSE_PROJECT VPS_ENV_FILE VPS_DEPLOY_SERVICES VPS_MIGRATE_SERVICE PUBLIC_URLS VPS_SSH_KEY VPS_KNOWN_HOSTS RELEASE_SHA; do [ -n "${!v:-}" ] || missing+=("$v"); done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::deployment blocked, missing configuration: ${missing[*]}"
  echo "Stopped without guessing. Configure the 'production' environment (docs/RELEASE_COORDINATOR.md) and re-run."
  exit 3
fi
[ "$VPS_HOST" = "$EXPECTED_HOST" ] || { echo "::error::VPS_HOST ($VPS_HOST) is not the approved host $EXPECTED_HOST"; exit 3; }

umask 077; KEYDIR="$(mktemp -d)"; trap 'rm -rf "$KEYDIR"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$KEYDIR/key"; printf '%s\n' "$VPS_KNOWN_HOSTS" > "$KEYDIR/known_hosts"
SSH=(ssh -i "$KEYDIR/key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KEYDIR/known_hosts" -o ConnectTimeout=20 "$VPS_USER@$VPS_HOST")
q() { printf '%q' "$1"; }
ENVS="APP_DIR=$(q "$VPS_APP_DIR") COMPOSE_FILE=$(q "$VPS_COMPOSE_FILE") COMPOSE_PROJECT=$(q "$VPS_COMPOSE_PROJECT") ENV_FILE=$(q "$VPS_ENV_FILE") SERVICES=$(q "$VPS_DEPLOY_SERVICES") MIGRATE_SERVICE=$(q "$VPS_MIGRATE_SERVICE") RELEASE_ID=$(q "$ID") RELEASE_SHA=$(q "$RELEASE_SHA")"
ENVS="$ENVS MIN_FREE_PCT=$(jq .deploy.minFreeDiskPercent "$DIR/config.json") MIN_FREE_GIB=$(jq .deploy.minFreeDiskGiB "$DIR/config.json") MIN_MEM_MIB=$(jq .deploy.minAvailableMemMiB "$DIR/config.json")"
[ -z "${VPS_AGE_IDENTITY:-}" ] || ENVS="$ENVS AGE_IDENTITY=$(q "$VPS_AGE_IDENTITY")"
remote() { echo "::group::VPS $1"; local rc=0; "${SSH[@]}" "env $ENVS bash -s -- $1" < "$DIR/deploy-remote.sh" || rc=$?; echo "::endgroup::"; return $rc; }
report() { echo "$*" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"; }

report "## Production deployment of \`$RELEASE_SHA\`"
remote preflight;       report "- preflight, VPS resources and rollback readiness: ok"
remote fetch;           report "- approved SHA fetched and verified on main: ok"
remote backup;          report "- backup taken, encrypted and verified on the off-server remote: ok"
remote restore_test;    report "- backup restore-tested into a scratch database: ok"
remote checkout_build;  report "- release checked out and images built (running containers untouched): ok"
remote rehearse;        report "- pending migrations rehearsed on the restored copy: ok"

if ! { remote deploy && remote verify; }; then
  report "- DEPLOY FAILED after production was touched."
  new_migs="$(remote new_migrations | tail -n1 | tr -dc '0-9')"
  if [ "${new_migs:-x}" = "0" ]; then
    report "- the release had no new migrations: rolling the code back automatically"
    if remote rollback_code; then report "- code rolled back to the previous release"; else report "- AUTOMATIC ROLLBACK FAILED: manual action required"; fi
  else
    report "- the release contained migrations: NOT rolling back automatically. Follow docs/DEPLOYMENT.md section 16 (restore the pre-deploy backup, redeploy the previous tag)."
  fi
  exit 1
fi
report "- release services migrated, deployed and healthy; every previously running container is still up"

fail=0
while IFS= read -r url; do
  [ -z "$url" ] && continue
  case "$url" in https://*) ;; *) report "- $url: refused (https only)"; fail=1; continue;; esac
  code="$(curl -sS -L --max-redirs 3 --max-time 25 -o /dev/null -w '%{http_code}' "$url" || echo 000)"
  if [ "${code:0:1}" = 2 ]; then report "- $url: HTTP $code"; else report "- $url: HTTP $code (FAILED)"; fail=1; fi
done <<<"$(printf '%s' "$PUBLIC_URLS" | tr ', ' '\n\n')"
[ "$fail" -eq 0 ] || { report "- public verification FAILED; see the rollback guidance in docs/DEPLOYMENT.md section 16"; exit 1; }
report "- public verification of printoutbuddy.tech and the other hosted services: ok"
