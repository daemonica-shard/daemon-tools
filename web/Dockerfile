# Build from the repo root: docker build -f web/Dockerfile .
FROM node:22-alpine AS build
RUN npm install -g pnpm@9
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY web/package.json web/
# The whole lib tree, for the same reason as in mcp-server/Dockerfile: a package's devDependencies
# (here typescript, which builds the pages) are only installed if its folder is there.
COPY lib lib
RUN pnpm install --frozen-lockfile --filter web...
COPY web web
# Builds roas-forecast, then the server and its pages (dist/pages/*.html, no data in them).
RUN pnpm --filter web... build \
 && pnpm --filter web deploy --prod /app

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app .
# A fresh named volume takes the image's ownership of /data; without this the uploads can't be saved.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
