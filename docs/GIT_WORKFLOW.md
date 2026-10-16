# Git workflow and CI/CD

Two developers, three permanent branches, short-lived feature branches, pull requests, CI on every change. **CI and deployment are separate**: nothing in this repository deploys automatically, and merging into any branch never authorizes a deployment.

```
feature/<dev>-<topic>  --PR-->  development  --release PR-->  production
```

| Branch | Role | Who changes it |
|---|---|---|
| `main` | **legacy/reference, frozen.** Kept unchanged for the existing server checkout and older integrations. Not a merge destination for features or releases and never the source of a new release. Still the GitHub default branch (changing that needs separate owner approval) | nobody, in ordinary work |
| `development` | shared integration; always green | pull requests from feature, fix and hotfix back-merge branches |
| `production` | stable, releasable | release pull requests from `development`, and hotfix pull requests; always through a PR with green CI |

Temporary branches: `feature/<developer>-<topic>` (for example `feature/daksh-rate-card-export`, `feature/amardeep-history-api`), `fix/<developer>-<topic>`, `hotfix/<topic>`. The names are flexible: any developer, including a future contributor, picks a short descriptive name that includes their own name; use lowercase words and hyphens.

## Current state (verify before relying on it)

- **Three permanent branches**: `main` (legacy/reference, default branch, frozen, never renamed or deleted), `development` (active integration) and `production` (release branch, to be created from the former stable `main` tip `7809abf`, never from `development`, and not merged with `development` until the first release PR). **`main` is not renamed**; the earlier plan to rename it is cancelled.
- Rulesets (active, no bypass actors): `development protection` (id 25244979, `refs/heads/development`) and `production protection` (id 25261486, `refs/heads/production` and `refs/heads/main`). Every permanent branch: pull request required, **0** approvals, code-owner review not required, resolved conversations, the five CI checks required with the branch up to date, no force-push, no deletion.
- Repository setting "Automatically delete head branches" is **on**: merged temporary branches disappear from the remote; the permanent branches cannot be deleted (ruleset), so a release PR never removes `development`.
- Both developers can merge any eligible PR: `singhdaksh7` (admin) and `AmardeepManav` (write).
- **Deployment is a fourth, separate concern** (see `docs/DEPLOYMENT.md`): a manually authorized operation on an explicit release commit or tag. No workflow deploys; merging into `production` deploys nothing.

## Daily developer commands

```bash
# start a feature from the latest development (never from production)
git fetch origin
git switch development && git pull --ff-only
git switch -c feature/daksh-rate-card-export

# work, commit small logical steps, run the local checks
corepack pnpm --filter @printout/web check test
corepack pnpm --filter @printout/api check

# publish the branch and open a PR into development
git push -u origin feature/daksh-rate-card-export
gh pr create --base development --fill   # optional: --reviewer AmardeepManav (or singhdaksh7); add --draft while in progress
```

Rules: one logical feature per branch; keep it small enough to review; rebase or merge `development` into your branch if it has moved (never force-push a branch someone else has checked out); do not commit secrets, `.env` files, database dumps or large binaries (design PDFs stay out of Git).

## Pull requests into `development`

- No approval is required (see Merge policy); asking the other developer for a review is optional and encouraged for risky changes.
- All CI jobs green (below). Resolve review conversations.
- Prefer squash merge for a single-topic branch; use a merge commit if the individual commits are worth keeping.
- Merged feature and fix branches are deleted remotely automatically (repository setting "Automatically delete head branches", see Branch cleanup). Local branches and worktrees are yours to keep or remove.

## CI (`.github/workflows/ci.yml`)

Runs on pull requests and pushes to `development` and `production` (and `main`, which stays a trigger because it is a protected permanent branch). Least-privilege (`contents: read`), actions pinned to commit SHAs, concurrent PR runs cancel superseded ones, every job has a timeout, pnpm is cached.

| Job (check name) | What it runs |
|---|---|
| `Web (types, tests, build)` | frozen install, typecheck, 338+ unit tests, production build, showcase-exclusion check |
| `API (types, schema, migrations, tests)` | typecheck, `prisma validate`, all migrations on an empty PostgreSQL 16, drift check against `schema.prisma`, API tests on a separate disposable database |
| `End-to-end (isolated database and ports)` | disposable PostgreSQL container, migrations, the 22 Playwright tests on API port 3187; failure artifacts (traces, screenshots, worker log) |
| `UI quality (axe, focus, overflow)` | the Playwright UI/axe suite; failure artifacts |
| `Security (secret scan, dependency audit)` | gitleaks over the full history (`.gitleaks.toml` allowlists only fake test fixtures); `pnpm audit` fails on **critical**, warns on high/moderate |

Known dependency advisories at the time of writing (reported, not blocking): `deepmerge-ts` < 8 (high; reached only through the Prisma CLI config, fixed by a Prisma upgrade) and `react-router` 6.x (moderate; fixed in 7.x, a major upgrade; the app only navigates to fixed internal paths and validates the post-login redirect). Track both and re-audit before each release.

CI uses disposable databases only and has no secrets. It never deploys and never touches a real database.

### Troubleshooting a red check

1. Open the failed job log; the first red step is the cause.
2. Reproduce locally with the same commands (`corepack pnpm --filter @printout/web test`, `corepack pnpm --filter @printout/api test` with `TEST_DATABASE_URL` pointing at a disposable database, `corepack pnpm e2e` with `E2E_DB_PORT`, `E2E_PG_CONTAINER`, `E2E_API_PORT`).
3. E2E and UI failures upload `e2e-failure` / `ui-failure` artifacts: open the Playwright trace (`pnpm exec playwright show-trace trace.zip`).
4. `API` drift failure means `schema.prisma` and the migrations disagree: add a forward migration, never edit an applied one.
5. gitleaks failure: remove the secret and rotate it if it was real; add an allowlist entry only for a fake fixture.
6. Flaky test: fix or quarantine with a ticket; do not re-run until green and ignore it.

## Merge policy

Two developers with **equal authority**: **singhdaksh7** (Daksh) and **AmardeepManav** (senior, write access). Either of them may merge any pull request, including their own, as soon as the required CI checks pass. There is **no required approval** on `development` or `production`; the safety nets are the mandatory pull request, the five green CI checks and resolved conversations.

- Reviews are optional. Ask for one when a change is risky: `gh pr create --reviewer AmardeepManav` (or `--reviewer singhdaksh7`).
- `.github/CODEOWNERS` lists both developers for the whole repository, only so GitHub offers each as a reviewer of the other's PRs (it requests everyone except the author). Code-owner review is **not** required (`require_code_owner_review: false`), and nobody is required to approve.
- A PR author can merge their own PR. Nothing can bypass failing CI.
- A review that requests changes is a human signal, not a technical block here: resolve it before merging.
- Releases (`development` to `production`) still go through a PR, must be green, and follow the release verification steps below (staging checks, migration and backup readiness) before anyone merges.

## Protection settings (active)

Applied from the reference payloads in `.github/rulesets/` (`development.json`, `production.json`); required check names match the contexts reported by real CI runs. Manage them under Settings > Rules > Rulesets, or `gh api -X PUT repos/singhdaksh7/printout-/rulesets/<id> --input .github/rulesets/<file>.json`. The production ruleset targets `refs/heads/production` and `refs/heads/main`; `main` is frozen for ordinary development and exists only for legacy compatibility.

| Rule | `development` | `production` |
|---|---|---|
| Require pull request | yes | yes |
| Required approving reviews | 0 | 0 |
| Code-owner review required | no | no |
| Approval of the most recent push | no | no |
| Required checks (branch must be up to date) | all five CI checks | all five CI checks |
| Resolve conversations | yes | yes |
| Block force push and deletion | yes | yes |
| Bypass actors | none (failing CI cannot be bypassed) | none |

Direct pushes are blocked as a consequence of "require pull request" (rulesets have no separate push switch). The author may merge their own PR because zero approvals are required. GitHub plan notes: the repository is public and owned by a personal account, so rulesets, required checks and required pull requests are available at no cost. Because there are no bypass actors, even the owner cannot push straight to a protected branch or merge with red checks; an emergency must go through a hotfix PR with green CI.

## Branch cleanup

Only temporary branches are ever deleted. `development` and `production` are permanent: the rulesets block their deletion and force-pushes. The repository setting **Automatically delete head branches** (`delete_branch_on_merge`) is **enabled**; it was switched on only after both rulesets were active, because a release PR has `development` as its head branch and GitHub does not delete a head branch that a ruleset protects from deletion. Branches and worktrees that exist locally are never touched by this setting.

```bash
# verify after a merge: only permanent and still-open branches remain on the remote
gh api repos/singhdaksh7/printout-/branches --jq '.[].name'
# after your PR merged: update the local checkout, then drop the local branch if you like
git switch development && git pull --ff-only && git fetch --prune
```

## Release: `development` to `production`

1. `development` is green and the staging checklist below passes.
2. `gh pr create --base production --head development --title "Release YYYY-MM-DD" `; the diff is the release notes. A review from the other developer is optional but recommended for a release.
3. All required checks green and the verification steps below complete before merging.
4. Database: read the target's `_prisma_migrations`, take and trial-restore a backup (`deploy/backup-db.sh`, `deploy/restore-db.sh`), and rehearse the new migrations on a restored copy.
5. Merge the PR. **Merging does not deploy, does not run migrations and does not authorize a deployment.**
6. Deployment is a separate operation (`docs/DEPLOYMENT.md`, "Release and deployment procedure"). Only after explicit authorization, deploy deliberately from the server: `bash deploy/deploy.sh` (order: backup, migrate, up, health wait). Then run `deploy/smoke.mjs` and watch `/ready`, logs and the uptime monitor.
7. Rollback: restore the pre-deploy backup and redeploy the previous image tag (migrations are forward-only).

### Staging checklist

Deploy the branch to a staging stack with a copy of production-like data (never production), run the migrations, `deploy/smoke.mjs`, a manual pass of customer upload, shop print, admin login and retention deletion, and a phone-width check of the shop screens.

## Hotfix

```bash
git fetch origin && git switch -c hotfix/short-description origin/production
# fix, test, commit
gh pr create --base production        # CI green, then merge
# deploy using the release steps above
git switch -c hotfix/back-merge origin/development
git merge origin/production           # bring the released fix back
gh pr create --base development
git branch --contains <fix-sha> -r    # verify both branches contain it
```

## `main` stays; it is not renamed

`main` is not renamed, deleted or used for new releases. The existing server checkout and older integrations may still track `origin/main`, so it is preserved as a protected, frozen reference. New releases come only from `production`. The GitHub default branch remains `main` until the owner separately approves a change; a PR opened without `--base` therefore targets `main`, so **always pass `--base development` (or `--base production` for releases)**.

Creating `production` (one time, from the verified `main` tip, never from `development`): `git push origin <main-tip-sha>:refs/heads/production` (no force). The production ruleset requires the five checks even on branch creation (`do_not_enforce_on_create: false`), which a brand-new branch can never satisfy, so the owner must either create the branch in the GitHub UI or temporarily set `do_not_enforce_on_create` to true on ruleset 25261486 and restore it immediately afterwards.

## Backups

Before any branch operation: `git bundle create <file> --all`, `git bundle verify <file>`, and a trial clone from the bundle; archive dirty and untracked files separately; keep the bundle outside the repository. Restore a branch with `git fetch <bundle> '<ref>:<ref>'`.
