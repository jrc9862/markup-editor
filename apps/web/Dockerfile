# Build from the repo root: docker build -f apps/web/Dockerfile .
#
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so
# they are build args here, not runtime env:
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_MARKUP_SERVER=https://markup.example.com \
#     --build-arg NEXT_PUBLIC_MARKUP_TOKEN=... .

FROM node:20 AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sync-core/package.json packages/sync-core/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @markup/sync-core --workspace @markup/web

COPY packages/sync-core packages/sync-core
COPY apps/web apps/web

ARG NEXT_PUBLIC_MARKUP_SERVER
ARG NEXT_PUBLIC_MARKUP_TOKEN
ENV NEXT_PUBLIC_MARKUP_SERVER=$NEXT_PUBLIC_MARKUP_SERVER \
    NEXT_PUBLIC_MARKUP_TOKEN=$NEXT_PUBLIC_MARKUP_TOKEN

# sync-core first: its package entry points at dist/
RUN npm run build --workspace @markup/sync-core \
 && npm run build --workspace @markup/web

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
# `output: 'standalone'` emits a self-contained server mirroring the monorepo
# layout (entrypoint at apps/web/server.js); static assets are served from
# .next/static, which tracing does not copy.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
