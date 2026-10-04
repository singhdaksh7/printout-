# syntax=docker/dockerfile:1
# Build context = repository root:  docker build -f apps/api/Dockerfile -t printout-api:local .
# Debian slim (glibc + openssl) because argon2 native binaries and Prisma engines need them.

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @printout/api...
COPY apps/api apps/api
RUN pnpm --filter @printout/api db:generate \
    && pnpm --filter @printout/api build \
    && rm -rf apps/api/dist/test
# Production-only dependency tree for the API package, then add the prisma CLI (a devDependency
# upstream, but required for `prisma migrate deploy`) at the version pinned in the lockfile.
RUN pnpm --filter @printout/api deploy --prod /out \
    && cp -r apps/api/dist apps/api/prisma /out/
WORKDIR /out
RUN PRISMA_V="$(node -p "require('./node_modules/@prisma/client/package.json').version")" \
    && pnpm add "prisma@${PRISMA_V}" \
    && pnpm exec prisma generate \
    && rm -rf /root/.cache

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data/uploads && chown -R node:node /app /data
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
USER node
ENV API_PORT=3000
ENV LOCAL_UPLOAD_DIR=/data/uploads
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Worker reuses this image: command: ["node", "dist/src/worker.js"]
# Migrations:               command: ["node_modules/.bin/prisma", "migrate", "deploy"]
# First admin:              command: ["node", "dist/prisma/bootstrap-admin.js"]
CMD ["node", "dist/src/server.js"]
