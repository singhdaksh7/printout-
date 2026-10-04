# syntax=docker/dockerfile:1
# Build context = repository root:  docker build -f apps/api/Dockerfile -t printout-api:local .
# Debian slim (glibc + openssl) because argon2 native binaries and Prisma engines need them.
# One image, three commands (see bottom): API server (default), worker, one-shot migrate / bootstrap-admin.
# Base image is pinned by digest for reproducible builds; bump deliberately (docker pull node:22-bookworm-slim).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate && apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @printout/api...
COPY apps/api apps/api
# dist/test (compiled tests) and dist/prisma/seed.js (demo accounts) are never shipped; dist/prisma/bootstrap-admin.js is emitted by tsc (tsconfig include has "prisma").
RUN pnpm --filter @printout/api db:generate \
    && pnpm --filter @printout/api build \
    && rm -rf apps/api/dist/test apps/api/dist/vitest.config.js apps/api/dist/prisma/seed.js
# Production-only dependency tree for the API package (no typescript/vitest/tsx/@types).
RUN pnpm --filter @printout/api deploy --prod /out \
    && cp -r apps/api/dist apps/api/prisma /out/
WORKDIR /out
# The prisma CLI is a devDependency upstream but is required at runtime for `prisma migrate deploy`.
# Add it (same version as @prisma/client) with NODE_ENV=production so pnpm does not pull devDependencies back in,
# regenerate the client, then drop caches and anything only needed to build.
RUN PRISMA_V="$(node -p "require('./node_modules/@prisma/client/package.json').version")" \
    && NODE_ENV=production pnpm add --save-prod "prisma@${PRISMA_V}" \
    && NODE_ENV=production pnpm exec prisma generate \
    && rm -rf /root/.cache /root/.local/share/pnpm /pnpm/store /tmp/* \
    && rm -rf node_modules/.pnpm/typescript@* node_modules/.pnpm/@types+* \
    && find node_modules/.pnpm -type f \( -name 'query_*_bg.mysql.*' -o -name 'query_*_bg.sqlserver.*' -o -name 'query_*_bg.cockroachdb.*' -o -name 'query_*_bg.sqlite.*' \) -delete
# ^ Postgres-only product: the last line drops Prisma wasm query compilers for other databases (driver adapters only).

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    # npm/yarn/corepack are not needed at runtime (nothing here installs packages)
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir -p /app /data/uploads && chown -R node:node /app /data
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
USER node
ENV API_PORT=3000
ENV LOCAL_UPLOAD_DIR=/data/uploads
EXPOSE 3000
# Liveness only (/health never touches the DB). Readiness (/ready) is for external monitors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Worker reuses this image: command: ["node", "dist/src/worker.js"]  (--once for a single cleanup run)
# Migrations:               command: ["node_modules/.bin/prisma", "migrate", "deploy"]
# First admin:              command: ["node", "dist/prisma/bootstrap-admin.js"]
CMD ["node", "dist/src/server.js"]
