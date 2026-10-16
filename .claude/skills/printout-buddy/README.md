# Printout Buddy Claude skill — starter kit

## Install locally for Claude Code

Copy the **entire folder** `printout-buddy-claude-skill` into your repository as:

```
<repo>/.claude/skills/printout-buddy/
  SKILL.md
  references/
  templates/ui/
```

That is, rename the provided outer folder to `printout-buddy` while placing it under `.claude/skills/`.

Then ask Claude Code: `Use the printout-buddy skill to compare our Prisma schema and existing API to the approved architecture. Produce an implementation plan only.`

## Contents
- `SKILL.md`: Claude instructions and guardrails.
- `references/ARCHITECTURE_CONTRACT.md`: source-derived architecture decisions.
- `references/SCHEMA_TARGET.md`: conceptual target schema + migration strategy.
- `references/API_TARGET.md`: all endpoints and agent message names explicitly listed in PDF.
- `references/UI_COMPONENTS.md`: proposed contracts/variants for three requested components.
- `templates/ui/`: Button, TextField, StatusChip/FilterChip + CSS reference implementations.

## Important status

These are **prepared documents and starter components**. They have **not** been applied to the GitHub repository, do **not** replace the existing Prisma schema, and do **not** make routes live. Further decisions are required for a production-ready executable schema and OpenAPI spec because the PDF does not specify all fields/payloads. Confirm exact target variants and design tokens before UI integration.

Original inputs: owner-approved `PrintoutBuddy Architecture.pdf` (13 pages) and Codex read-only audit of `development` at c15a47a (2026-10-16).

## Status

`references/IMPLEMENTATION_STATUS.md` records what is built. `templates/ui/` is kept for history only; the real components are in `apps/web/src/ui/`.
