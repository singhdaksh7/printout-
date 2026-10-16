## What and why

<!-- One logical change. Link the issue or task. -->

## How it was tested

- [ ] `corepack pnpm --filter @printout/web check test`
- [ ] `corepack pnpm --filter @printout/api check test` (disposable database only)
- [ ] Browser/e2e coverage added or updated where behaviour changed
- [ ] Screenshots for UI changes (phone and desktop widths)

## Risk checklist

- [ ] No secrets, `.env` files, database URLs, dumps or large binaries
- [ ] Database changes are additive, forward-only migrations (no edits to applied ones)
- [ ] API changes keep existing routes and the `{ data }` / `{ error }` envelopes
- [ ] Reuses the shared UI components in `apps/web/src/ui`
- [ ] Merging this does not need a deployment or a production migration (or the release steps in docs/GIT_WORKFLOW.md are noted below)

## Notes for the reviewer
