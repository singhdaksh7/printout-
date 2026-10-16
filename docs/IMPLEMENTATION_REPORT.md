# Implementation report (2026-10-16)

## 1. Executive summary

Stage 1 was validated, the remaining Shopkeeper and Platform Admin screens were moved onto the shared UI library, the schema gained additive target-architecture tables, API documentation was written, and the Claude skill was finalized. All work is committed locally on `development`. Nothing was pushed or deployed and no production database was touched. The `main` to `production` rename and branch protections are blocked on your approval.

## 2. Requirements completed

- Stage 1 validated by the full e2e suite against an isolated database (22/22 on `ee7fa46`, 22/22 again at the end).
- "New" chip removed from queue rows (every row in the New tab has status NEW, so it repeated the tab). Later states keep their chips; Order Detail unchanged and still a full page on `/shop/orders/:id`.
- Shopkeeper migration in the requested order: Rate Card, QR and standee, Devices, History (see 7), Settings, Shell and responsive navigation.
- Platform Admin migration, schema alignment, API documentation, skill finalization, `admin:update` script.

## 3. Files and directories changed

`apps/web/src/shop`, `apps/web/src/admin`, `apps/web/src/ui` (`pages.css`, index import), `e2e/` (selectors for the new markup, tolerant session-expiry click), `apps/api/prisma` (schema, migration, `update-admin.ts`), `apps/api/package.json`, `docs/` (five new documents, `openapi/current.yaml`), `.claude/skills/printout-buddy`.

## 4. Database models and migrations

`20261016120000_target_architecture_additive`: `Membership`, `PrintAgent`, `Printer`, `PrintJob`, `DeletionReceipt`, `CustomerSession`, `Invoice`, `Payment`; new nullable columns on `Shop`, `Plan`, `Subscription`, `Document`; three new `ShopStatus` values; one backfill (owner memberships). Details and unresolved decisions: `docs/SCHEMA_ALIGNMENT.md`. Verified on disposable databases: row counts unchanged, 2 memberships created, no schema drift, clean database applies. Note: this migration was committed together with the `admin:update` script (`1d8c8ba`).

## 5. API documentation delivered

`docs/API_TARGET_SPEC.md` (conventions, envelopes, pagination, validation, auth, status matrix, compatibility map, WebSocket protocol, lifecycle and retention), `docs/openapi/current.yaml` (47 verified paths; parses as YAML), existing `docs/API_CONTRACT.md` untouched. No routes were added or changed.

## 6. Components

No new components were needed for the migrations; the existing library (`apps/web/src/ui`) covered every screen. Shared page layout moved into `ui/pages.css`. Dead legacy `sh-*` CSS and unused legacy components in `shop/components.tsx` were removed.

## 7. Shopkeeper screens

Done: print queue, order detail, rate card (with a worked example computed from the typed price only), QR and standee controls (poster and print rules unchanged), devices, settings, shell (sidebar, top bar, phone tab bar; Staff and Reports shown as non-interactive "Soon"), sign-in. **History:** the app has no history endpoint, so the existing Analytics screen was migrated and keeps its name and route; the design's History table (date filters, CSV export) is not built. The design's printer-health, agent and billing content is not shown because nothing backs it.

## 8. Admin screens

Done: shell, dashboard, shops list and create, shop detail (status, subscription), orders metadata, plans, subscriptions, audit log, sign-in. Metadata only; no 2FA, agent monitoring, support sessions, deletion verification or payments.

## 9. Skill changes

New `references/IMPLEMENTATION_STATUS.md` (stack, schema rules, tokens, component inventory and reuse rule, accessibility, commands, git, deferred features); `SKILL.md` and README updated; the old `templates/ui` starter is marked superseded. No secrets, personal paths, fonts or PDFs.

## 10. Tests executed

| Check | Result |
|---|---|
| Web typecheck | pass |
| Web unit/component tests | 338 passed |
| Web production build and `verify:bundle` | pass, showcase absent |
| UI browser checks (`e2e:ui`, axe, 1280/855/375) | 15 passed |
| API typecheck | pass |
| API tests (disposable DB, new schema applied) | 415 passed, 35 files |
| App end-to-end (isolated DB, own API port) | 22 passed |
| Migration data preservation and drift check | pass |

Not run: Android builds, real printer tests, anything against production.

## 11. Git branch status

Local `development` is ahead of `origin/development` by 24 commits (unpushed). Remote still has `main` and `development`. Backups before any change: a bundle of all refs plus archives of dirty and untracked worktrees, checksummed, stored outside the repository; restore with `git fetch <bundle> '<ref>:<ref>'`. All other branches and worktrees were left untouched.

## 12. Deferred and why

Windows agent, Kotlin/Ktor, OTP/2FA, staff authorization, payments (all out of scope by instruction); customer sessions and customer SSE, chunked uploads and the 25 MB limit, page-1 preview, deletion receipts, one-year deletion (unspecified or unapproved; see `docs/SCHEMA_ALIGNMENT.md`); customer page migration (no approved design).

## 13. Known limitations and architectural differences

Order, not PrintJob, is authoritative. Status vocabulary is the API's ("Print started", legacy labels), not the design's, because the API does not confirm physical printing. Order Detail is a page, not a drawer. Phone tab bars hold five destinations (Devices reached from Settings; Plans from Subscriptions). Upload limit is 50 MB against a 25 MB target. Screens were compared with the PDFs by eye on screenshots only.

## 14. Deployment readiness

Not ready to deploy from this report alone: the work is unpushed, the migration has not been applied to any real database, and the UI changes have had no manual browser review on real devices. Apply the migration to a staging copy of production data first.

## 15. Follow-up actions for the project owner

1. Review and approve pushing `development`.
2. (Superseded) `main` stays as the production branch and is not renamed; branch protections are active (`docs/GIT_WORKFLOW.md`).
3. Decide the open schema questions (`docs/SCHEMA_ALIGNMENT.md`).
4. Decide whether a History endpoint (date and status filters, export) should be built.
5. Apply the migration to staging, then production, when ready.
6. Stop the disposable test database when done: `docker rm -f printout-e2e-pg`.
