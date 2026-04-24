FROM node:20-slim AS base
RUN npm install -g pnpm@10

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
# pnpm --frozen-lockfile validates the lockfile against every workspace package,
# so all package.json files in the workspace must exist even if we only build @kyomiru/db.
COPY packages/config/package.json ./packages/config/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/providers/package.json ./packages/providers/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/extension/package.json ./apps/extension/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY packages/config ./packages/config
COPY packages/db ./packages/db
RUN pnpm --filter @kyomiru/db build
# SQL files must live alongside compiled JS so __dirname-relative paths resolve
RUN cp -r packages/db/src/migrations packages/db/dist/migrations

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/node_modules ./node_modules
CMD ["node", "packages/db/dist/migrate.js"]
