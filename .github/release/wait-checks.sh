#!/usr/bin/env bash
# wait-checks.sh <sha> [timeout-minutes]
# Waits until every required check (config.json) is green on exactly <sha>. Fails on any failed/cancelled check or on timeout.
# Needs: GH_TOKEN (checks: read), jq, gh. Never retries or re-runs a failed check.
set -euo pipefail
SHA="${1:?sha}"; TIMEOUT_MIN="${2:-45}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(jq -r .repo "$DIR/config.json")"
mapfile -t REQUIRED < <(jq -r '.requiredChecks[]' "$DIR/config.json")
deadline=$((SECONDS + TIMEOUT_MIN * 60))
while :; do
  runs="$(gh api --paginate "repos/$REPO/commits/$SHA/check-runs?per_page=100" --jq '.check_runs[] | {id, name, status, conclusion}' | jq -s '.')"
  pending=0
  for name in "${REQUIRED[@]}"; do
    row="$(jq -c --arg n "$name" '[.[] | select(.name == $n)] | sort_by(.id) | last // empty' <<<"$runs")"
    if [ -z "$row" ]; then echo "  - $name: not reported yet"; pending=1; continue; fi
    status="$(jq -r .status <<<"$row")"; concl="$(jq -r '.conclusion // "none"' <<<"$row")"
    if [ "$status" != "completed" ]; then echo "  - $name: $status"; pending=1; continue; fi
    if [ "$concl" != "success" ]; then echo "::error::required check '$name' concluded '$concl' on $SHA"; exit 1; fi
    echo "  - $name: success"
  done
  [ "$pending" -eq 0 ] && { echo "all ${#REQUIRED[@]} required checks are green on $SHA"; exit 0; }
  [ "$SECONDS" -lt "$deadline" ] || { echo "::error::timed out after ${TIMEOUT_MIN} min waiting for required checks on $SHA"; exit 1; }
  sleep 30
done
