# syntax=docker/dockerfile:1
# Build context = repository root:  docker build -f apps/web/Dockerfile -t printout-web:local .
# Base images are pinned by digest for reproducible builds; bump deliberately.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG NGINX_IMAGE=nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @printout/web...
COPY apps/web apps/web
RUN pnpm --filter @printout/web build

FROM ${NGINX_IMAGE} AS runtime
# Runs as the unprivileged `nginx` user (works with read_only + cap_drop ALL): pid file in /tmp, no `user` directive.
RUN rm -f /etc/nginx/conf.d/default.conf \
    && sed -i -e '/^user /d' -e 's#/run/nginx.pid#/tmp/nginx.pid#' /etc/nginx/nginx.conf \
    && chown -R nginx:nginx /var/cache/nginx
COPY deploy/nginx-web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
