# Branches, phases and rollback

## Branch policy (verified from `docs/GIT_WORKFLOW.md`)

Permanent: `main` (production code, GitHub default) and `development` (integration). Feature PRs target `development`; release PRs go `development` to `main`; nothing deploys on merge. Verified at skill creation: `development` is **behind and diverged from `main`** (main has 9 commits not in development, development has 26 not in main), so before Phase 1 code the maintainers should merge `main` into `development` through a sync PR (pattern: `chore/sync-hotfix-34-to-development`). Docs-only changes are safe on either base. Audit result (2026-10-28): every `development`-only commit is already in `main` by content (squash releases); the tree of `development` has no unique functionality. Candidate sync branch `sync/main-into-development-candidate` merges `main` into `development` with a tree identical to `main` (reviewed, not yet merged). Do not rewrite or force-push either branch. Re-check with `git rev-list --left-right --count origin/main...origin/development`.

## Phases (PROPOSED, `docs/schema-v2/11`)

0 docs; 1 identity and multi-shop (M1); 2 discovery: profile, verification, paper options, images, nearby with PostGIS behind an interface (M2-M4); 3 customer ordering (M5); 4 lifecycle and payments (M6, D7 rollout); 5 reviews and notifications; 6 rollout (retention only if separately approved). Each phase: own branch and PR, tests, rollback plan, compatibility report. Stop at any BLOCKED item.

## Approvals this skill does NOT grant

Destructive or production migrations, enabling PostGIS on production, changing retention, replacing live authentication, switching the live order enum or lifecycle, deploying, merging, or pushing to permanent branches. Each needs explicit owner approval in the current conversation. Migration steps: verified backup, restore trial, disposable database, `prisma migrate diff` shows no drift, then ask.
