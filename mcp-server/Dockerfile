# Build from the repo root: docker build -f mcp-server/Dockerfile .
FROM node:22-alpine AS build
RUN npm install -g pnpm@9
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY mcp-server/package.json mcp-server/
COPY lib/firebase/package.json lib/firebase/
RUN pnpm install --frozen-lockfile --filter mcp-server...
COPY lib lib
COPY mcp-server mcp-server
RUN pnpm -r build \
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
