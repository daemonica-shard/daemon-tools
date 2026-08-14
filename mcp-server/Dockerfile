# Build from the repo root: docker build -f mcp-server/Dockerfile .
FROM node:22-alpine AS build
RUN npm install -g pnpm@9
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY mcp-server/package.json mcp-server/
# The whole lib tree, not one package.json per package: listing them individually meant every new
# shared package failed the build with "tsc: not found", because its devDependencies were never
# installed. Costs a little layer caching — lib is small and changes rarely.
COPY lib lib
RUN pnpm install --frozen-lockfile --filter mcp-server...
COPY mcp-server mcp-server
# `--filter mcp-server...` builds the server and its dependencies only. Plain `pnpm -r` also tries
# to build jobs/, which isn't copied into this image.
RUN pnpm --filter mcp-server... build \
 && pnpm --filter mcp-server deploy --prod /app

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    CONFIG_PATH=/config/tenants.yaml \
    AUDIT_LOG_PATH=/data/audit.jsonl
WORKDIR /app
COPY --from=build /app .
# Docker initializes a fresh named volume from the image's content at the mount point,
# ownership included. Without this, /data is created root-owned and the `node` user
# can't write the audit log.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
