---
name: printout-buddy
description: Use when planning, implementing, reviewing, or testing Printout Buddy schema, API, and shared web UI components. Enforces the approved architecture PDF, change safety, and traceability.
---

# Printout Buddy engineering skill

## Scope and authority

Read `references/IMPLEMENTATION_STATUS.md` first (what is built, commands, deferred features), then `references/ARCHITECTURE_CONTRACT.md`, `references/SCHEMA_TARGET.md`, `references/API_TARGET.md`, and `references/UI_COMPONENTS.md` when the task touches their subject. These are implementation working specifications **derived from** the user-approved `PrintoutBuddy Architecture.pdf` (13 pages). The PDF is the approved conceptual target; where it lacks details, this skill labels proposals rather than inventing binding requirements. The current repository and audit describe the **as-is** system, not the approved target.

## Mandatory workflow

1. Inspect `git status --short`, `git branch -avv`, `git worktree list --porcelain`, and the target files before doing edits. Check for unpublished histories and untracked files. Never delete/overwrite them.
2. State which requirement and PDF page(s) each change implements. List open questions before modifying ambiguous contracts.
3. Make narrow incremental changes on `development` (or a temporary branch only when authorized). Never push, rename branches, or change production without explicit authorization.
4. For schema edits: compare Prisma/SQL to the target; make additive, forward-only migrations; preserve data and legacy clients; do NOT modify applied migration files. Do not treat Kotlin/Ktor migration as a simple schema task.
5. For API edits: validate schemas, authentication/authorization, idempotency, privacy, response/error shapes, and cross-client compatibility. Separate target endpoints from currently implemented endpoints.
6. For UI edits: use the shared component library in `apps/web/src/ui/` (documented in `docs/UI_COMPONENT_SYSTEM.md`) and the approved design PDFs in `docs/design/` (`1.pdf` design system, `2.pdf` Platform Admin, `3.pdf` Shopkeeper). Import from `ui`, use `--pb-*` tokens and `.pb-*` classes, never hard-code hex values or add a duplicate of an existing component, and add new components only when an approved design shows them and a screen needs them (tests, showcase entry and docs included). Run `pnpm --filter @printout/web check test build`, `pnpm --filter @printout/web verify:bundle` and `pnpm e2e:ui` (axe, screenshots) before reporting a UI change finished. Migrate one screen family at a time, keep routes, API calls and auth untouched, and never make an unsupported feature look operational (use `comingSoon`). Keep React web and Compose Android implementations distinct. Accessibility and existing workflows take precedence over visual uniformity. `references/UI_COMPONENTS.md` is the older working contract and is superseded by the library docs where they differ.
7. Use isolated disposable databases for migration/tests. Never run destructive test fixtures against an unknown DB. No real customer file uploads in tests.
8. Produce a change log: requirement, files, migration/rollback plan, tests, risks, unimplemented portions, and questions for product owner.

## Branch policy

Target remote branches: `development` (integration) and `production` (stable). The remote still has `main`; the rename awaits owner approval (`docs/GIT_WORKFLOW.md`). Safely preserve unpublished local histories and untracked work before renaming/deleting. Never assume the remote reflects local Android/UI/email work.

## Source precedence

1. Explicit new user/team decision.
2. Approved architecture PDF for **target** behavior.
3. This skill's reference docs as working interpretation, not an override of PDF.
4. Current code and existing docs for **as-is** behavior.

When current code differs from target, report a gap; do not silently claim implementation exists.

## Deliverable modes

- **Audit/plan:** report exact evidence and gaps, no edits.
- **Spec:** generate reviewed field-level/API/UI contracts, annotate TBDs.
- **Implement:** modify only authorized scope, test, and report; stop on unsafe unknowns.

The starter files in `templates/ui/` are superseded by `apps/web/src/ui/`; do not copy them. Always reuse the library components instead of duplicating markup.
