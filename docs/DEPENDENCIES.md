# Dependency advisories (pnpm audit, 2026-10-04)

`corepack pnpm audit --prod` reports **3** advisories (1 high, 2 moderate); `corepack pnpm audit` (all, incl. dev tooling) reports 12 (1 critical, 2 high, 9 moderate, all of them dev-only apart from the 3 below).
**No upgrade was applied**: every fix needs a major version (or a transitive pin that upstream controls), and the latest releases within the current majors are already installed (`prisma`/`@prisma/client` 6.19.3 is the last 6.x; `react-router-dom` 6.30.6 is the last 6.x). Re-run the audit before every release.

## Production (runtime) dependencies

| Package (path) | Advisory / severity | Fixed in | Reachable here? | Why accepted | Mitigation |
| --- | --- | --- | --- | --- | --- |
| `deepmerge-ts` 7.1.5 (`@prisma/client > prisma > @prisma/config`) GHSA-ggr8-5vv4-36mx | stack exhaustion on deeply recursive objects; **high** | 8.0.0 (pinned by Prisma 6.x `@prisma/config`; Prisma 7 is a major upgrade) | No. Only the Prisma **CLI** (`migrate deploy`, `generate`) merges its own config; no request data ever reaches it. The API process never calls it. | Major Prisma upgrade is out of scope for a hardening pass; no attacker-controlled input. | CLI runs only as the one-shot `migrate` job on the backend network. Revisit with the Prisma 7 migration. |
| `react-router` 6.30.6 (`apps/web > react-router-dom`) GHSA-wrjc-x8rr-h8h6 | open redirect via backslash in `<Link>` / `useNavigate`; **moderate** | 7.18.0 (major) | No. Every `navigate()`/`<Navigate>` target is a hard-coded internal path or an id built with `encodeURIComponent`; the only user-influenced value (`state.from` after login) is accepted only if it starts with `/shop` (`shop/LoginPage.tsx`) and never comes from a URL parameter. | React Router 7 is a major upgrade (data APIs/types). | Keep the "internal paths only" rule; the CSP (`form-action 'self'`, `frame-ancestors 'none'`) limits impact. |
| `react-router` 6.30.6 GHSA-337j-9hxr-rhxg | arbitrary constructor injection in `deserializeErrors()` (SSR hydration); **moderate** | 7.18.0 (major) | No. The app is a client-only SPA; there is no SSR / framework mode / hydration payload. | Not applicable to SPA mode. | None needed. |

## Development / test tooling only (never shipped in the images)

The API image installs production dependencies only (`pnpm deploy --prod`); typescript, vitest, vite, esbuild, tsx and `@types/*` are not in it (verified: `ls node_modules/.pnpm` inside `printout-api`). The web image ships only the built static files behind nginx.

| Package | Advisory | Severity | Note |
| --- | --- | --- | --- |
| `vitest` 2.1.9 (apps/api) | arbitrary file read when the **Vitest UI server** is listening (GHSA, <3.2.6) | critical (dev) | We never run `vitest --ui`; tests run headless. Fix = vitest >= 3.2.6 (apps/web already uses 3.2.7); upgrading apps/api from 2.x to 3.x is a major bump of a test runner, left for a normal maintenance change. |
| `vitest` 2.1.9 / 3.2.7, `@vitest/mocker` | path traversal via redirect mocks (<4.1.11) | moderate (dev) | Only when running attacker-supplied test files. |
| `vite` 5.4.21 (via apps/api vitest), `esbuild` 0.21.5 | dev-server `fs.deny` bypass (Windows), `.map` path traversal, esbuild dev-server request exposure | high/moderate (dev) | Affect the dev **server** only; the API tests use vitest in node mode, no vite dev server is exposed. |

## Process

1. `corepack pnpm audit --prod` must show nothing new before a release; anything new and high/critical is a release blocker unless it is demonstrably unreachable and recorded here.
2. Prefer `corepack pnpm up <pkg>` within the same major, then run `apps/web: check/test/build` and `apps/api: check` + tests with a private database (`CREATE DATABASE printout_test_ops`; `TEST_DATABASE_URL=...`).
3. Base images are pinned by digest in the Dockerfiles (`node:22-bookworm-slim`, `nginx:1.27-alpine`) and the compose file (`postgres:16-alpine`, `caddy:2-alpine`); bump them deliberately (monthly) and rebuild.
