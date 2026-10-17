# Implementation status, commands and guardrails (as built)

All paths are relative to the repository root. This describes the code as it is, not the target in the Architecture PDF.

## Stack and scope

TypeScript, Fastify, Prisma and PostgreSQL in `apps/api`; React, TypeScript and Vite in `apps/web`; Android (Kotlin/Compose) on separate branches. Do **not** migrate to Kotlin/Ktor in this assignment. Authority order: the owner's latest instruction, then the Architecture PDF (target), then this skill, then the code (as-is).

## Documents to read first

| Subject | File |
|---|---|
| Current API (verified) | `docs/API_CONTRACT.md`, `docs/openapi/current.yaml` |
| Target API, status matrix, WebSocket protocol, retention | `docs/API_TARGET_SPEC.md` |
| Schema additions and unresolved decisions | `docs/SCHEMA_ALIGNMENT.md` |
| UI library, tokens, migration status | `docs/UI_COMPONENT_SYSTEM.md` |
| Git branches and pending approvals | `docs/GIT_WORKFLOW.md` |
| Real-time order notifications (outbox, SSE, bell, sound) | `docs/REALTIME_NOTIFICATIONS.md` |

## Database and schema rules

Additive, forward-only migrations in `apps/api/prisma/migrations`; never edit an applied migration; never drop or rename in the same release as the code that stops using a column. `Order` is authoritative; `PrintJob`, `Membership`, `PrintAgent`, `Printer`, `DeletionReceipt`, `CustomerSession`, `Invoice`, `Payment` exist but are unused. Do not invent status mappings or wipe-flag names. Validate on a disposable database only (never an unknown or production database); use separate databases for migrations, API tests (`TEST_DATABASE_URL`, truncated by the tests) and e2e (`printout_e2e`, truncated by the suite).

## Real-time notifications (do not build a second system)

Shop new-order notifications are durable (`ShopNotification`, written in the order-creation transaction) and pushed as `notification.created` on the existing single `/shop/events` stream; the inbox API is `GET /shop/notifications`, `POST /shop/notifications/:id/read`, `POST /shop/notifications/read-all`. The browser state lives in `apps/web/src/shop/notifications.tsx` (provider), `NotificationBell.tsx`, and `alert-sound.ts` (the one shared opt-in sound, preference key `printout.shop.sound`). Rules: payloads carry only order id and number; events are emitted only after commit; the sound rings only for live notifications, never for refresh, reconnect or history; reuse the one `RealtimeProvider` connection.

## Design tokens

Navy `#14213D` (`--pb-navy`), orange `#E8772E` (`--pb-orange`), orange ink `#B04E17` (`--pb-orange-ink`), paper `#FBFBF8` (`--pb-paper`), neutrals `--pb-n50..n700`, status `--pb-ok/warn/err/info` plus `-soft`. Fonts: Rubik (display), DM Sans (body), JetBrains Mono (codes), self-hosted. Source of truth: `apps/web/src/ui/tokens.css`. Never write a hex value in a screen.

## UI components: reuse, do not duplicate

Import from `apps/web/src/ui` (`import { Button, Card, TextField } from '../ui'`). Inventory: Button, IconButton, SegmentedControl, Tabs; TextField, TextArea, Select, Checkbox, RadioGroup; Chip, Badge, Spinner, ProgressBar; Banner, useToast/ToastRegion, Skeleton, EmptyState; Card, CardHeader, StatTile, KeyValueList, Timeline; Modal, Drawer; DataTable, LoadMore; AppShell, Sidebar, TopBar, BottomNav; BarChart, HBarList, HeartbeatStrip, SegmentedBar; JobCode, JobStatusChip, OrderStatusChip, ShopStatusChip, PresenceChip, RetentionNotice, FileDeletedLine. Before writing markup, check this list and `docs/UI_COMPONENT_SYSTEM.md`; add a component only when an approved design shows it and a screen needs it (props, tests, showcase entry, docs). Page layout helpers live in `ui/pages.css` and `shop/pb-pages.css`. The older `templates/ui/` starter files are superseded; do not copy them.

Migrated: Shopkeeper (queue, order detail, rate card, QR and standee, devices, analytics, settings, shell, sign-in) and Platform Admin (shell, dashboard, shops, shop detail, orders metadata, plans, subscriptions, audit log, sign-in). Not migrated: customer pages (no approved design supplied).

## Accessibility standards

WCAG 2.1 A/AA. Native semantics first; every input has a visible label; errors use `role="alert"`; focus is visible and trapped in overlays; touch targets at least 44 px; no horizontal scroll at 360 px; reduced motion respected; accessible names contain visible text. Components are tested with role/name queries and axe.

## Verification commands

```bash
corepack pnpm --filter @printout/web check          # types
corepack pnpm --filter @printout/web test           # unit and component tests
corepack pnpm --filter @printout/web build && corepack pnpm --filter @printout/web verify:bundle   # showcase must not ship
corepack pnpm e2e:ui                                # axe and screenshots of the showcase
corepack pnpm --filter @printout/api check
TEST_DATABASE_URL=<disposable db> corepack pnpm --filter @printout/api test
E2E_DB_PORT=<port> E2E_PG_CONTAINER=<disposable postgres container> E2E_API_PORT=<free port> corepack pnpm e2e
```

## Git workflow

Work on a feature branch from `development`; long-lived branches are `development` and `production` (`docs/GIT_WORKFLOW.md`); CI is `.github/workflows/ci.yml`, secrets scanning is configured in `.gitleaks.toml`. Commit one logical stage at a time. Never push, rename branches, force-push, delete unmerged work or run production migrations without explicit approval. Preserve unpublished worktrees and branches.

## Deliberately deferred (show as Coming soon or not at all, never as working)

Windows Print Agent; Kotlin/Ktor backend; OTP login and admin 2FA; staff roles and authorization; billing, payment processing, UPI Autopay; reports; customer sessions and SSE for customers; chunked uploads and the 25 MB limit; page-1 preview image; deletion-receipt verification; automatic one-year metadata deletion; (History table with date filters and CSV export is now built on the Order model: `/shop/history`, `/shop/orders/history*`.)

## Keep out of the skill

Secrets, credentials, personal paths, binary fonts and the large design PDFs.

Order value report (built on the Analytics page): `GET /shop/analytics/revenue` and `/revenue/export.csv`. It shows ESTIMATED order value from the stored quote `Order.totalPaise` only. There are no customer payment records, so never label it revenue, earnings or money collected; collected revenue, refunds and net earnings stay unavailable until a verified payment source exists. Rules: IST days, counted = not CANCELLED/EXPIRED, integer paise, no re-pricing of history.
