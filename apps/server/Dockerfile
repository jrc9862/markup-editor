# Build from the repo root: docker build -f apps/server/Dockerfile .
# Full node image for the build (better-sqlite3 may compile from source);
# slim image at runtime.

FROM node:22 AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sync-core/package.json packages/sync-core/
COPY apps/server/package.json apps/server/
RUN npm ci --workspace @markup/sync-core --workspace @markup/server

COPY packages/sync-core packages/sync-core
COPY apps/server apps/server
RUN npm run build --workspace @markup/sync-core \
 && npm run build --workspace @markup/server \
 && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
# SQLite fallback files land here when DATABASE_URL is unset; mount a volume.
ENV MARKUP_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app /app
RUN mkdir /data
EXPOSE 4000
CMD ["node", "apps/server/dist/index.js"]
