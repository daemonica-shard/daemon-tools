# daemon-tools

Org-level automation & tooling monorepo for the **Daemonica / TapEmpire** mobile games:
CI pipelines, a hosted aggregator MCP server, scheduled jobs, Claude agents, and shared libraries —
everything that lives *around* the game projects rather than inside them.

Serves two Unity games across two GitHub orgs: **WordGame** (TapEmpire) and **Sway** (Daemonica).

> **Public repo.** Only generic workflow/tool logic lives here. All secrets — Unity license,
> signing certs, Firebase service accounts, bot tokens — live as secrets in each consuming repo
> or on the server, **never in this repo**.

See [CLAUDE.md](CLAUDE.md) for architecture, roadmap, and key technical decisions.

## Layout (built incrementally)

| Path | Purpose |
|------|---------|
| `.github/workflows/` | Reusable CI workflows (GameCI Unity build) |
| `fastlane/` | iOS signing (match) + TestFlight (pilot), Play upload (supply) |
| `mcp-server/` | Hosted aggregator MCP (HTTP/SSE, Google OAuth, allowlist, audit log) |
| `jobs/` | Scheduled jobs (Crashlytics digest, Coda↔RC drift) |
| `lib/` | Shared fetchers used by both `mcp-server` and `jobs` |
| `agents/` | Claude agent definitions |
| `deploy/` | Caddy + Docker Compose |

## Status

Phase 1: **CI** (GameCI build → iOS TestFlight / Android). See roadmap in [CLAUDE.md](CLAUDE.md).
