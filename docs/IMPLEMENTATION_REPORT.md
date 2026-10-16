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

Done: print queue, order detail, rate card (with a worked example computed from the typed price only), QR and standee controls (poster and print rules unchanged), devices, settings, shell (sidebar, top bar, phone tab bar; Staff and Reports shown as non-interactive "Soon"), sign-in. **History:** built after the first migration (`feature/daksh-order-history`): `/shop/history` with `GET /shop/orders/history`, `/summary` and `/export.csv` (see API_CONTRACT). It is metadata only (files are never opened, downloaded or reprinted from it), uses Asia/Kolkata days, and shows "Print started / Print initiated", never a physical-print confirmation. Analytics keeps its name and route (sidebar; linked from History on phones). The design's printer-health, agent and billing content is not shown because nothing backs it.

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
4. ~~History endpoint~~ built (order history list, summary, CSV). Open: export row cap (5,000) and whether to add a customer-reference column.
5. Apply the migration to staging, then production, when ready.
6. Stop the disposable test database when done: `docker rm -f printout-e2e-pg`.

## 16. Admin account security (branch `feature/daksh-admin-security`)

Platform admins can change their own email and password at `/admin/account` (current password required, all sessions ended, transactional, audited). Backend: `routes/admin-account.ts` and the shared `password-policy.ts`; UI: `admin/AccountPage.tsx` (Account link in sidebar and top bar; `AuthProvider.endSession()` added). The `admin:update` and `bootstrap-admin` CLIs are unchanged in behaviour and covered by tests. Details: API_CONTRACT (Platform admin) and SECURITY_REVIEW (Admin account self-service). Not included: OTP/2FA, public admin registration, email verification.

## 17. Order value report (branch `feature/daksh-revenue-dashboard`)

**Data sources and gaps (checked before building).** The only money in the schema for customer orders is `Order.totalPaise` (plus `priceSnapshot`): the price quoted from the shop's rate card when the order was created. There is no customer payment, settlement, refund or cost record; cash is settled at the counter. `Invoice`/`Payment` are the shop's own subscription billing and are unused. The dashboard therefore reports **estimated order value only**. Collected revenue, refunds, costs and net earnings are explicitly unavailable (`collected.available:false`), and no UI text, API field or CSV column claims money was received.

**Metrics** (IST calendar days, inclusive, bucketed by `Order.createdAt`): order count (all statuses); counted orders (not CANCELLED/EXPIRED); estimated order value = SUM(`totalPaise`) of counted orders (integer paise, bigint in SQL); pages requested = SUM(selectedPageCount x copies), with orders lacking a page count reported separately; print started; average estimated order value; cancelled/expired counts and their excluded quoted value; breakdowns by colour mode, sides, paper size and status; zero-filled daily series; comparison with the equally long preceding window (percentages suppressed for a zero or pre-first-order baseline). History is never re-priced: the stored quote is used, so later rate-card changes do not alter past days.

**Implementation.** `apps/api/src/domain/revenue.ts` (one grouped aggregate per window, CSV) and `routes/shop-revenue.ts` (two routes). No schema change and no migration, so deployment needs no database step. UI: `shop/RevenuePanel.tsx` inside the existing Analytics page, `lib/revenue.ts`, optional `tooltip` on `BarChart` bars. Tests: API `test/revenue.test.ts`, web `shop/__tests__/revenue.test.tsx`, browser `e2e/11-shop-revenue.spec.ts` (exact figures, filters, export, isolation, error/Retry, 768/390/360 px, axe).

**Known limitations.** Estimates only (not money received); the quote is the price at order time, not necessarily what the customer paid at the counter; orders are dated by creation, not print or pickup; max range 93 days; export capped at 5,000 rows; the existing Analytics tiles above the report still describe "today". Collected revenue, refunds and net earnings need a future verified payment source.

## 18. Real-time order notifications

Added on `feature/daksh-realtime-notifications`: durable shop notifications (transactional outbox table `ShopNotification`, additive migration `20261016195159_shop_notifications`), inbox API (`GET /shop/notifications`, `POST /shop/notifications/:id/read`, `POST /shop/notifications/read-all`), `notification.created` on the existing `/shop/events` stream, a bounded cross-process poller, retention sweep in the worker, and the shop notification bell (unread badge, panel, toast, optional shared sound, multi-tab de-duplication). Design, guarantees and limits: `docs/REALTIME_NOTIFICATIONS.md`. The Print queue's old "beep on any refresh that finds a new order" was replaced by the single live-notification sound (it rang on reload and reconnect).
