# Git workflow

## Target branches

| Branch | Purpose |
|---|---|
| `development` | active development and integration; all application work lands here |
| `production` | stable, releasable code; only fast-forwarded or merged from a reviewed `development` |

Feature branches are short-lived and merge into `development` by pull request.

## State at the time of writing (verified against GitHub)

Remote branches: `main` and `development`, both at `c15a47a`; default branch `main`. Local `development` is 11+ commits ahead of `origin/development` (unpushed). Local worktrees and branches (`phase2/*`, `phase3/*`, `agent/*`, `feature/resend-email-system`, `design/approved-ui-implementation`) hold unpublished work and must be kept.

## Pending (needs the owner's approval, not done)

Renaming the remote default branch changes shared state and may break anything that tracks `main` (hosting, webhooks, CI). Run these when approved:

```bash
# 1. Rename on GitHub (keeps history, open PRs retarget, moves the default branch)
gh api -X POST repos/singhdaksh7/printout-/branches/main/rename -f new_name=production
# 2. Point local clones at it
git fetch origin && git branch -m main production && git branch -u origin/production production
git remote set-head origin -a
# 3. Verify exactly two long-lived branches remain
gh api repos/singhdaksh7/printout-/branches --jq '.[].name'     # production, development
# 4. Re-check external integrations that named `main` (hosting auto-deploy branch, webhooks)
```

Branch protection (needs repository admin; the signed-in account has it). Suggested ruleset for `production`: require pull request, require status checks, block force pushes and deletion; for `development`: block force pushes and deletion.

```bash
gh api -X POST repos/singhdaksh7/printout-/rulesets --input ruleset-production.json
```

## Rules

No force-push, history rewrite or deletion of unmerged branches. Do not remove worktrees that contain unpublished commits. Take a bundle backup (`git bundle create <file> --all`, then `git bundle verify <file>`) before any branch operation. Restore a branch from a bundle with `git fetch <file> '<ref>:<ref>'`.

## Local verification

`git branch -avv`, `git worktree list`, `git status --short` before and after every branch operation.
