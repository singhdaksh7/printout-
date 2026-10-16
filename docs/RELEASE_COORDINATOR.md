# Release coordinator (one-time, event-driven)

Workflow: `.github/workflows/release-coordinator.yml`. Scripts and config: `.github/release/`. Self-test: `.github/workflows/release-coordinator-selftest.yml`.

```
WAIT -> 3/3 FEATURES MERGED -> INTEGRATION TESTS -> MAIN PR -> FIVE GREEN CHECKS -> MERGE -> VERIFIED VPS DEPLOYMENT -> COMPLETE
```

It runs on GitHub, so it keeps working with the laptop and Claude Code closed. **It is disarmed by default** (see "Arming").

## What it waits for

Release id `printout-three-feature-release-1` waits for merged pull requests from these same-repository head branches into `development`:

1. `feature/daksh-ui-polish`
2. `feature/daksh-realtime-notifications`
3. `feature/daksh-revenue-dashboard`

A feature counts only if GitHub's pull request record says it is merged into `development` **and** its merge commit is an ancestor of `development`'s tip (branch existence or deletion is never consulted; fork PRs, closed-unmerged PRs, other bases and unrelated PRs are ignored). The logic is `gate.mjs` and is unit-tested (`gate.test.mjs`).

## Phases

| Phase | Job | Behaviour |
|---|---|---|
| 1 | `gate` | Triggered by every push to `development` (a PR merge) and by `workflow_dispatch` (recovery from missed events). Read-only. 0-2 merged: records **WAITING** in the run summary and exits successfully. Opens nothing, deploys nothing. |
| 2 | `verify` | Pins the exact development SHA. Requires the five required CI checks green on it; tests for Order History, Admin Security, notification delivery, tenant isolation and revenue calculations must **exist** (fail closed) and pass; combined e2e, axe/accessibility suite, `pnpm audit` (critical); migration history is an unmodified prefix of `main`'s and the upgrade path (main's schema + new migrations) is clean and drift-free. Any failure stops everything. |
| 3 | `release` (environment `release-main`) | Aborts if `development` moved or `main` holds commits `development` lacks (a back-merge is needed). Opens or reuses the release PR, waits for the five checks on its head, requires `mergeable_state == clean`, merges with a **merge commit** and `--match-head-commit` through the normal rulesets (no bypass), dispatches CI on `main` (GITHUB_TOKEN merges do not trigger push events), waits for the five checks on the resulting commit, then tags `release-<id>` at that exact SHA. |
| 4 | `deploy` (environment `production`) | Needs reviewer approval. Over SSH to `77.37.45.177` with a pinned host key: preflight (Traefik compose file only, clean checkout, disk/memory thresholds, previous images present = rollback ready), fetch and verify the tag is on `main`, backup + verified off-server copy, restore test into a scratch database, build, rehearse migrations on the restored copy, migrate, `up -d --no-deps` for the named services only, health wait, confirm every previously running container (other projects included) is still up, then HTTPS checks of `PUBLIC_URLS`. A failed deploy with no new migrations rolls the code back automatically; with migrations it stops and reports (restore per `docs/DEPLOYMENT.md` section 16). |
| 5 | `complete` | Writes tag `deployed-<id>`; every later run exits as COMPLETE. |

## One-time guarantees

- **Persistent id and state**: git tags `release-printout-three-feature-release-1` (merged and tagged) and `deployed-printout-three-feature-release-1` (finished). No tag: nothing released. Release tag only: the next run resumes at deployment of that exact SHA. Both: inert.
- **No duplicates**: workflow `concurrency` group `release-coordinator` (never cancels a running release); every step is idempotent (reuses the open release PR, an existing merge, an existing tag with the same SHA).
- **Never partial, never early**: phases 2-5 require state READY (3/3). The deployed SHA is the tagged `main` commit, never `development`.
- **Branch guard**: the coordinator refuses to run from any ref but `development`.
- **Least privilege**: workflow-level `permissions: {}`; each job gets only what it needs. Only `complete` can write the completion tag and it holds no production secrets. Action versions are pinned by SHA. Secrets exist only in the `production` environment and are used only by the `deploy` job; the SSH key is written to a `umask 077` temp dir and deleted.
- **Not touched**: existing workflow logic and rulesets (the only change to `ci.yml` is adding the `workflow_dispatch:` trigger), `deploy/deploy.sh` and the Caddy compose file (the coordinator refuses `docker-compose.prod.yml` and any `*caddy*` file), other VPS compose projects, containers and databases.
- **Retry**: after a failure fix the cause and run the workflow again (Actions > Release coordinator > Run workflow, ref `development`). `stop_after` lets you rehearse a prefix (`gate`, `verify`, `release`, `deploy`).

## Known limitation to resolve before the first real run

`main` currently contains a merge commit that `development` does not (release PR #8). The `main` ruleset requires an up-to-date branch, so the coordinator will stop at phase 3 with a clear error until a back-merge PR (`main` into `development`) has merged. Plan for this when scheduling the release.

## Arming checklist (all owner actions; nothing here has been done)

1. Security-review this PR (`/security-review`) and merge it to `development` through the normal PR flow.
2. Settings > Actions > General: allow GitHub Actions to create pull requests (needed by phase 3). Workflow permissions default can remain read-only.
3. Settings > Environments:
   - `release-main`: deployment branches = `development`; no secrets.
   - `production`: **required reviewers** (you and/or `AmardeepManav`), deployment branches = `development`, and these (environment-scoped) values:
     - variables: `VPS_HOST` (must equal `77.37.45.177`), `VPS_USER`, `VPS_APP_DIR`, `VPS_COMPOSE_FILE` (the existing **Traefik** compose file; must mention traefik), `VPS_COMPOSE_PROJECT`, `VPS_ENV_FILE`, `VPS_DEPLOY_SERVICES` (space separated, only this app's services), `VPS_MIGRATE_SERVICE`, `PUBLIC_URLS` (comma/space separated `https://` URLs: `https://printoutbuddy.tech/ready` plus the other hosted services), optional `VPS_AGE_IDENTITY` (path on the server);
     - secrets: `VPS_SSH_KEY` (a dedicated deploy key limited to the app user), `VPS_KNOWN_HOSTS` (the server's pinned host key line from `ssh-keyscan`, verified out of band).
   - The server env file needs `BACKUP_RCLONE_REMOTE` and an age/gpg recipient (the preflight refuses otherwise). The Traefik-based compose must keep the service name `postgres` that `deploy/backup-db.sh` uses.
4. Open the three feature PRs and let them merge. Until then every push just records WAITING.
5. When ready: set the repository variable `RELEASE_COORDINATOR_ARMED` to `true` (Settings > Secrets and variables > Actions > Variables). Remove it, or set anything else, to disarm instantly.

Until step 5 the gate still runs and reports, but `verify`, `release` and `deploy` are skipped.

## What could not be verified before merging

The workflow and scripts cannot be executed end to end from a developer machine: the gate logic, the check/ruleset consistency and shell syntax are tested (`node --test .github/release/gate.test.mjs`), but phases 2-4 need GitHub-hosted runs, the three real feature PRs, the environment configuration above and the Traefik compose project on the VPS (whose layout is not in this repository). Do a dry run first: `workflow_dispatch` with `stop_after: gate`, then `verify` (armed), then `release`.
