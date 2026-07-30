# daemon-tools

Automation & tooling monorepo for mobile games.

## Layout (built incrementally)

| Path | Purpose |
|------|---------|
| `.github/workflows/` | Reusable CI workflows (GameCI Unity build) |
| `mcp-server/` | Hosted multi-tenant MCP server (one endpoint per project, bearer-key auth, audit log) |
| `lib/firebase/` | Shared Firebase fetchers (Remote Config template + versions, TTL cache) |
| `config/` | `tenants.example.yaml` — real tenant config lives only on the server |
| `deploy/` | The whole server: Caddy + Docker Compose + landing (see `deploy/README.md`) |

## MCP server

```
pnpm install
pnpm keygen                # generate an API key + hash for tenants.yaml
cp config/tenants.example.yaml config/tenants.yaml   # fill in hashes
pnpm dev                   # http://localhost:3000/<tenant>/mcp
pnpm test
```

## Status

Phase 1 (CI): Android done, iOS deferred. Phase 3 (hosted MCP): server skeleton — auth + audit + multi-tenant routing.
