---
name: printout-buddy-architecture
description: Use when planning, implementing or reviewing Printout Buddy schema-v2 work (customer accounts, multi-shop, nearby search, customer orders, REJECTED status, cash/UPI tracking, reviews, retention) or any change that must reconcile the 23-page schema PDF with the existing production system. Separates CURRENT_PRODUCTION from APPROVED_TARGET, PROPOSED, BLOCKED and SUPERSEDED.
---

# Printout Buddy architecture (schema-v2)

Use this with `printout-buddy` (UI library, branch/CI workflow, as-built status). This skill covers the **PDF-to-repository evolution**; it never authorizes migrations, deployment, pushes to `main`/`development`, or production access.

## Status labels (use them in every plan, PR and answer)

| Label | Meaning | May be called an existing API/feature? |
|---|---|---|
| CURRENT_PRODUCTION | In code on `main` and live contract | yes |
| APPROVED_TARGET | Owner confirmed in writing | no, only a target |
| PROPOSED | In `docs/schema-v2/`, owner has not confirmed (includes every "OWNER_PREFERENCE_PENDING" decision) | no |
| BLOCKED | Depends on an unresolved decision or permission | no, do not build |
| SUPERSEDED | Replaced by a later decision | no, ignore |

**As of this skill's creation no decision is APPROVED_TARGET.** D1-D8 in `docs/schema-v2/02-architecture-decisions.md` are PROPOSED (owner preference pending). Re-read that file for the current status before relying on any decision; if the owner has confirmed one, the file says so. Never infer approval.

Anything in the PDF that is not in code is **not an existing API**. The PDF's endpoints, error shape, token model and sample domain are specifications, not contracts.

## Source order

1. Explicit new owner instruction. 2. `docs/schema-v2/02-architecture-decisions.md` (decisions, status). 3. The PDF `printout_buddy_schema.pdf` (23 pages, supplied by the owner; not committed to the repo, ask for it) for target business rules. 4. Current code (`apps/api/prisma/schema.prisma`, routes) for as-is behaviour and every live contract. Docs describing the as-is: `docs/API_CONTRACT.md`, `docs/architecture/` (PR #44 until merged).

## Hard rules (non-negotiable)

- Preserve every CURRENT_PRODUCTION contract: Android bearer + rotating refresh (`POST /auth`, `/auth/refresh`, `/auth/logout`), web cookie + CSRF, admin password + TOTP, guest QR ordering (`/public/...`), quote tokens, tracking tokens, shop SSE and notifications, Windows Agent and device routes.
- Firebase ID tokens are exchanged once at the auth endpoints; never accepted by other routes. Do not adopt the PDF's "ID token on every call".
- Never link or sign in identities by matching email or phone. No "claim by phone", no "reuse user by phone".
- Pricing stays per sheet (`PricingRule.pricePerSheetPaise`, `Order.priceSnapshot`); never reinterpret as per page; duplex = correct sheet logic; client amounts ignored; integer paise.
- Retention stays 30 minutes after print / 24 hours unprinted unless the owner separately approves a change. Deleting the stored original does not delete local spool/Android copies.
- Payments are customer-to-shop tracking only: a UTR is an unverified claim, only the shop sets `paid`, no gateway, no platform billing, shops stay free.
- Schema changes are additive, forward-only, never edit applied migrations, never drop/rename/retype in the same release. Test on disposable databases only.
- Do not touch Windows Agent, `Device*`, `PrintAgent`, `Printer`, `PrintJob` models or Phase B branches without coordination. No status transition may re-queue a physical print.
- Keep response/error envelopes (`{data}`, `{error:{...}}`) on new routes. New routes are additive (`/customer/...`, `/shops/{shopId}/...`); never repurpose a live route.
- Tenant checks come from the session/`Membership`, never from client-supplied ids alone.
- No secrets, tokens or production credentials in code, docs or tests.

## Workflow

1. `git status`, `git branch -avv`, confirm the base (see `references/BRANCH_AND_PHASES.md`: `development` is currently behind `main`).
2. Read the relevant reference below, then the decision rows it cites. State each change as CURRENT_PRODUCTION, APPROVED_TARGET, PROPOSED or BLOCKED.
3. If the work depends on a PROPOSED or BLOCKED item, stop and ask the owner; do not implement behind a flag and call it done.
4. One phase per PR; include tests, rollback plan and a compatibility note (Android, Windows Agent, web).
5. Never push to a permanent branch, merge, migrate, or deploy without explicit authorization.

## References (load only what the task needs)

| Topic | File |
|---|---|
| Decision register and statuses | `docs/schema-v2/02-architecture-decisions.md` |
| PDF vs code gaps | `docs/schema-v2/01-pdf-to-code-gap-analysis.md`, `references/SOURCES.md` |
| Entities, ER, migrations | `docs/schema-v2/03`, `04`, `07` ; `apps/api/prisma/schema.prisma` |
| API mapping and labels | `docs/schema-v2/05-api-contract-mapping.md`, `references/CONTRACTS_AND_AUTH.md` |
| Auth, Android token contract, security | `references/CONTRACTS_AND_AUTH.md`, `docs/schema-v2/06` |
| Customer/shop flows, Windows Agent | `references/FLOWS_AND_COMPAT.md` |
| Order, pricing, payment state machines | `references/STATE_PRICING_PAYMENT.md`, `docs/schema-v2/08` |
| Retention | `docs/schema-v2/09-storage-retention-impact.md` |
| Branches, phases, rollback | `references/BRANCH_AND_PHASES.md`, `docs/schema-v2/11`, `12` |
