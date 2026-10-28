# Sources and how to read them

| Source | Location | Authority |
|---|---|---|
| Schema PDF (23 pages): tables, enums, API, business logic | `printout_buddy_schema.pdf`, supplied by the owner in the planning conversation. **Not committed to this repository.** Ask the owner for a copy; do not search the machine for it. | Target business rules only. Placeholder domain `api.printoutbuddy.example` and `shp_...` ids are samples. |
| Gap analysis (field by field) | `docs/schema-v2/01-pdf-to-code-gap-analysis.md` | PROPOSED analysis, evidence from code at `origin/main` `080c6bd` |
| Decisions | `docs/schema-v2/02-architecture-decisions.md` | Status per decision |
| Target ER, mapping, migrations | `docs/schema-v2/03`, `04`, `07` | PROPOSED |
| API mapping | `docs/schema-v2/05` | labels CURRENT_LIVE / CURRENT_DIFFERENT_CONTRACT / NEW_PROPOSED / DEPRECATED |
| Current Prisma schema | `apps/api/prisma/schema.prisma` | CURRENT_PRODUCTION (32 models, 14 enums at creation time; re-count with `grep -c '^model '`) |
| Current API | `docs/API_CONTRACT.md`, `docs/openapi/current.yaml`, `docs/architecture/api-inventory.md` (PR #44) | CURRENT_PRODUCTION |
| Older target docs (13-page PDF era) | `docs/API_TARGET_SPEC.md`, `docs/SCHEMA_ALIGNMENT.md`, `.claude/skills/printout-buddy/references/*` | Partly SUPERSEDED by schema-v2 where they differ; still valid for UI and as-built notes |

PDF summary of 11 tables: users, userFcmTokens, shops, shopRates, shopPaperOptions, shopImages, orders, orderStatusHistory, reviews, notifications, auditLogs. Enums: userRole, printingType, orderStatus, paymentMethod, paymentStatus. 33 operations (auth/me 5, shop discovery 3, customer uploads/orders/payment/review 9, owner 8, admin 4, plus presign).
