# Agent rules and collaboration

## Ownership

| Area | Primary owner | Others |
| --- | --- | --- |
| `apps/api`, Prisma schema/migrations, auth, storage, pricing, orders, jobs, security, API tests | Codex | Consult contract before integration |
| `apps/web`, customer/shop/admin UI, responsive UX, PWA | Antigravity | Do not implement server policy |
| End-to-end integration, contract verification, E2E, final QA | Cursor | May submit focused fixes with owner coordination |
| `packages/shared`, `docs/API_CONTRACT.md` | Codex proposes/owns | All agents review changes affecting them |

## Rules

1. Read `MASTER_SPEC.md` and `API_CONTRACT.md` before starting. Treat their frozen decisions as source of truth.
2. Work only in owned paths. Do not reformat, rewrite, or move another owner's area without an agreed handoff.
3. Contract changes are additive where possible, documented first, and communicated before dependent code changes.
4. Use small focused commits when asked; never push, merge, rebase shared history, or commit unrelated work automatically.
5. Before handoff, report changed paths, checks run, contract changes, and known gaps. Preserve unrelated dirty work.
6. Never add real secrets, production credentials, public document URLs, or document fixtures containing personal data.
7. Database changes use reviewed Prisma migrations committed to source control. Never use `prisma db push` as a migration strategy.
8. API-side authorization, tenant scope, price calculation, status transitions, and deletion schedules cannot be implemented exclusively in UI code.

## Integration protocol

Antigravity can use mock adapters generated from the documented contract until API endpoints exist. Codex publishes schemas/types in `packages/shared` only after the API contract change is agreed. Cursor compares UI calls and API validation against contract examples, then owns E2E wiring and reports discrepancies rather than silently changing semantic behavior.
