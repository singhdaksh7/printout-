#!/usr/bin/env bash
# Phase 3: release development -> main through the NORMAL protection rules. Never bypasses, force-pushes, or edits a ruleset.
# Env: GH_TOKEN (contents:write, pull-requests:write, actions:write, checks:read), DEV_SHA (the SHA Phase 2 verified), FEATURE_PRS.
# Idempotent: safe to re-run after a failure (reuses the open release PR; an already-merged release resumes at verification).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(jq -r .repo "$DIR/config.json")"; ID="$(jq -r .releaseId "$DIR/config.json")"
DEV="$(jq -r .integrationBranch "$DIR/config.json")"; MAIN="$(jq -r .productionBranch "$DIR/config.json")"
: "${DEV_SHA:?}" "${GH_TOKEN:?}"
TAG="release-$ID"
out() { [ -z "${GITHUB_OUTPUT:-}" ] || echo "$1=$2" >> "$GITHUB_OUTPUT"; }
fail() { echo "::error::$*"; exit 1; }

head_now="$(gh api "repos/$REPO/branches/$DEV" --jq .commit.sha)"
[ "$head_now" = "$DEV_SHA" ] || fail "$DEV moved ($head_now) since verification of $DEV_SHA; stopping. The next push will start a fresh run."

# Reuse a previous attempt: a release PR for exactly this SHA that already merged.
merged_sha="$(gh pr list --repo "$REPO" --base "$MAIN" --head "$DEV" --state merged --json mergeCommit,headRefOid --jq "[.[] | select(.headRefOid==\"$DEV_SHA\")][0].mergeCommit.oid // empty")"
if [ -z "$merged_sha" ]; then
  # Branch must be up to date: main must contain nothing that development lacks (the ruleset enforces this too).
  behind="$(gh api "repos/$REPO/compare/$DEV...$MAIN" --jq .ahead_by)"
  [ "$behind" = "0" ] || fail "$MAIN has $behind commit(s) that $DEV does not contain. Open a back-merge PR ($MAIN -> $DEV), let it merge, and re-run the coordinator (workflow_dispatch). Nothing was changed."

  pr="$(gh pr list --repo "$REPO" --base "$MAIN" --head "$DEV" --state open --json number --jq '.[0].number // empty')"
  if [ -z "$pr" ]; then
    body="Automated release \`$ID\` (release coordinator, docs/RELEASE_COORDINATOR.md).

Verified development SHA: \`$DEV_SHA\`
Feature pull requests: ${FEATURE_PRS:-n/a}

Merging this PR deploys nothing by itself; the production deployment is a separate, environment-protected job."
    pr="$(gh pr create --repo "$REPO" --base "$MAIN" --head "$DEV" --title "Release $ID" --body "$body" | sed 's#.*/##')"
  fi
  echo "release PR: #$pr"; out release_pr "$pr"

  echo "waiting for the five required checks on $DEV_SHA"
  bash "$DIR/wait-checks.sh" "$DEV_SHA" 60

  state=""; for _ in $(seq 1 20); do
    read -r mergeable mstate sha < <(gh api "repos/$REPO/pulls/$pr" --jq '"\(.mergeable) \(.mergeable_state) \(.head.sha)"')
    [ "$mergeable" != "null" ] && [ "$mstate" != "unknown" ] && { state="$mstate"; break; }; sleep 6
  done
  [ "$sha" = "$DEV_SHA" ] || fail "release PR head $sha differs from the verified $DEV_SHA"
  [ "$mergeable" = "true" ] || fail "release PR #$pr is not mergeable (mergeable=$mergeable state=$state)"
  [ "$state" = "clean" ] || fail "release PR #$pr is not in state 'clean' (state=$state): behind, blocked or has unresolved conversations. No bypass attempted."

  # Squash merge through the standard workflow. --match-head-commit refuses if the head moved.
  gh pr merge "$pr" --repo "$REPO" --squash --match-head-commit "$DEV_SHA"
  merged_sha="$(gh api "repos/$REPO/pulls/$pr" --jq '.merge_commit_sha')"
fi
[ -n "$merged_sha" ] || fail "could not determine the release merge commit"
echo "release merge commit on $MAIN: $merged_sha"

# Verify CI on the resulting main commit. Merges made with GITHUB_TOKEN do not trigger push workflows, so dispatch CI explicitly.
main_tip="$(gh api "repos/$REPO/branches/$MAIN" --jq .commit.sha)"
[ "$main_tip" = "$merged_sha" ] || fail "$MAIN tip ($main_tip) is not the release merge commit ($merged_sha); someone pushed after the merge. Stopping; re-run after review."
if ! gh api "repos/$REPO/commits/$merged_sha/check-runs?per_page=100" --jq '.check_runs[].name' | grep -qx "$(jq -r '.requiredChecks[0]' "$DIR/config.json")"; then
  gh workflow run ci.yml --repo "$REPO" --ref "$MAIN"
  sleep 20
fi
bash "$DIR/wait-checks.sh" "$merged_sha" 60

# Record + tag the exact release SHA with an ANNOTATED tag (idempotent; an existing tag must resolve to the same commit).
existing="$(gh api "repos/$REPO/git/ref/tags/$TAG" --jq .object.sha 2>/dev/null || true)"
if [ -z "$existing" ]; then
  tag_obj="$(gh api "repos/$REPO/git/tags" -f tag="$TAG" -f message="Release $ID: $merged_sha (squash of verified development $DEV_SHA). Features: ${FEATURE_PRS:-n/a}" -f object="$merged_sha" -f type=commit --jq .sha)"
  gh api "repos/$REPO/git/refs" -f ref="refs/tags/$TAG" -f sha="$tag_obj" >/dev/null
else
  resolved="$(gh api "repos/$REPO/commits/$TAG" --jq .sha)"
  [ "$resolved" = "$merged_sha" ] || fail "tag $TAG already resolves to $resolved, not $merged_sha"
fi

# A squash leaves main one commit ahead of development (same content). Open the back-merge PR so the NEXT release is not blocked.
# It goes through the normal rules and is never merged here.
if [ -z "$(gh pr list --repo "$REPO" --base "$DEV" --head "$MAIN" --state open --json number --jq '.[0].number // empty')" ]; then
  gh pr create --repo "$REPO" --base "$DEV" --head "$MAIN" --title "chore: back-merge $MAIN after release $ID"     --body "Squash release of $ID left $MAIN ahead of $DEV by the squash commit $merged_sha (no content difference). Merge with a merge commit." >/dev/null || echo "::warning::could not open the back-merge PR; open one manually"
fi
out release_sha "$merged_sha"
{ echo "## Release merged and tagged"; echo "- Tag: \`$TAG\`"; echo "- Release SHA: \`$merged_sha\`"; echo "- Verified development SHA: \`$DEV_SHA\`"; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
