# Printout

Printout is a mobile-web-first SaaS that lets neighbourhood print shops accept and manage document print requests through a shop-specific QR code.

## Repository layout

```
apps/web          Customer, shop, and admin PWA (owned by Antigravity)
apps/api          Modular-monolith API (owned by Codex)
packages/shared   Versioned shared contracts, schemas, and types
docs              Product, API, and collaboration source of truth
```

## Getting started

1. Copy `.env.example` to `.env` and supply only local development values.
2. Install dependencies with `pnpm install` (once applications are implemented).
3. Read `docs/MASTER_SPEC.md`, then `docs/API_CONTRACT.md`, before changing product behavior.

This is foundation-only scaffolding. No customer-facing flow, database schema, migrations, authentication, or storage integration is implemented yet.

## Design principles

- One shared, tenant-isolated platform—not one deployment per shop.
- The API owns authorization, pricing, document lifecycle, and state transitions.
- Documents are private, temporary objects; they are never stored in PostgreSQL.
- Favour a modular monolith and inexpensive operational primitives.

See `docs/AGENT_RULES.md` for ownership and collaboration rules.
