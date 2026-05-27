# daemon-tools

Org-level **automation & tooling monorepo** for the Daemonica / TapEmpire mobile games. Houses CI pipelines, a hosted aggregator MCP server, scheduled jobs, Claude agents, and shared libraries — everything that lives *around* the game projects rather than inside them.

Consumers:
- **WordGame** — Unity mobile game, lives in the **TapEmpire** GitHub org.
- **Sway** — Unity mobile drawing/gesture prototype (forked from WordGame), lives in the **Daemonica** GitHub org. Checked out locally as a sibling of this repo.

Both games are Unity (C#), iOS + Android, built on the shared TapEmpire internal library (TEL).

## Why this repo exists (and why it's separate)

- The automation surface (CI YAML, MCP servers, jobs, agents) is **not Unity runtime code** and does not belong in TEL (`_TapEmpireLibrary`), which stays scoped to shared Unity runtime.
- It is **shared across two GitHub orgs** (TapEmpire + Daemonica). To avoid the cross-org access tax (PAT rotation, allowlists, GitHub App setup), **this repo is PUBLIC**. Only generic workflow/tool logic is exposed; all secrets (Unity license, signing certs, Firebase service accounts, bot tokens) live as secrets in each consuming repo or on the server, never here.
- **Monorepo, not repo-per-tool.** Decisive reason: the MCP tools and the scheduled jobs **share data fetchers** (e.g. Crashlytics MCP tool + Crashlytics digest job both read the same Firebase/BigQuery source; Coda tool + drift-check job both read Coda). A monorepo lets them import a shared `lib/` instead of duplicating code or publishing internal packages. Split into multiple repos only if a tool ever needs independent OSS release or a radically different stack — not at current scale.

## Repo structure (built incrementally — do NOT pre-scaffold empty folders)

```
daemon-tools/                 (public, daemonica org)
├── .github/workflows/        # reusable CI workflows (build-unity.yml, ...)
├── fastlane/                 # Fastfile, Matchfile (iOS signing + TestFlight)
├── mcp-server/               # hosted aggregator MCP
│   └── src/
│       ├── tools/            # remote-config, crashlytics, github, coda, datalens, asana
│       └── auth/             # Google OAuth + email allowlist + audit log
├── jobs/                     # scheduled jobs
│   ├── crashlytics-digest/
│   └── coda-rc-drift/
├── lib/                      # ★ SHARED — fetchers used by BOTH mcp-server and jobs
│   ├── firebase/
│   ├── coda/
│   └── notify/               # Telegram/Discord sender
├── agents/                   # Claude agent definitions (upstream-porter, onboarding)
├── deploy/                   # Caddy + docker-compose
└── docs/
```

If MCP/jobs are TypeScript, make it a **pnpm/npm workspaces** monorepo so `mcp-server` and `jobs` import `lib` cleanly.

**Lives in the GAME repos, NOT here:**
- Per-game CI wrapper workflow (`.github/workflows/build.yml`) — GitHub Actions only triggers on its own repo. ~10-line wrapper that `uses:` the reusable workflow here.
- Editor build-setup method (`BuildSetup.*`) — Unity C# code.
- Autotest suites — they test game code.

## Tool inventory

### CI / build
- Reusable Unity build workflow (GitHub Actions + GameCI `unity-builder`).
- Fastlane lanes: `match` (signing material in encrypted git repo), `gym` (build `.ipa`), `pilot` (upload to TestFlight), `supply` (Play Console).

### Hosted aggregator MCP (one server, many tools)
- MCP server core — HTTP/SSE (Streamable HTTP) transport + Google OAuth + email allowlist + audit log.
- Tools: Remote Config, Crashlytics, GitHub, Coda, Datalens, Asana (Asana only if/when used).

### Scheduled jobs / routines
- Crashlytics digest → notification channel.
- Coda ↔ Remote Config drift check.
- Upstream-sync routine (WordGame upstream → Sway).

### Agents
- `upstream-porter` subagent — knows WordGame→Sway namespace mapping, cherry-picks + opens PRs.
- Onboarding/permissions agent — grants a new hire access across all systems (GitHub, Firebase IAM, Coda, allowlist, ...). Real agent (side effects), built last.

### Shared infrastructure
- Notification sender (Telegram or Discord) — used by CI, jobs, MCP alerts.
- Server config (Caddy + Docker Compose).

### Game-side (in game repos, tracked here for context only)
- Autotest framework + stroke-recognition regression suite (for Sway's $1 unistroke recognizer).

## Roadmap / phases

Work top-down; resolve gating decisions before blocked work.

1. **CI** *(current focus)* — GameCI build, iOS+Android × debug+release, `workflow_dispatch` (button) + `push: tags: ['v*']`. iOS → fastlane match/gym/pilot → TestFlight. Android → fastlane supply (or artifact). Reusable workflow here + thin wrapper in each game repo.
2. **Notification channel** — Telegram bot or Discord webhook (PENDING choice); shared `lib/notify`.
3. **Hosted MCP platform** — provision server, Caddy + Docker Compose, DNS `mcp.<domain>` at Namecheap, MCP skeleton + Google OAuth + allowlist + audit log + one test tool to validate auth.
4. **Firebase integrations** — Crashlytics (enable BigQuery export → MCP tool + digest job) + Remote Config (MCP tool). Ship together.
5. **More integrations** — GitHub, Coda, Datalens, Asana. ~1–2 days each once platform exists.
6. **Supporting routines** — Coda↔RC drift check; upstream-sync (mid priority, likely one-shot / learning exercise for the porter-subagent shape).
7. **Autotest framework** (game-side) — scope what's testable in Sway ($1 recognizer = easy unit tests, input = simulated, HUD = Zenject harness, visuals = skip), then stroke regression suite, then generalize.
8. **Onboarding/permissions agent** — after platform is mature.

## Key technical decisions

### CI
- **Unity license: Personal** (free). Activation via `UNITY_LICENSE` secret holding a `.ulf` file. Caveat: `.ulf` is bound to a machine fingerprint and GitHub runners are ephemeral; if activation breaks, re-run GameCI activation → upload `.alf` to https://license.unity3d.com/manual → paste new `.ulf` into secret (~10–15 min, happens 1–2×/yr).
- **Editor build config**: the existing in-editor build-setup button is a static method callable headlessly via `Unity -batchmode -executeMethod BuildSetup.<Method>` / GameCI `buildMethod:`. Same code, no duplication. (Confirm exact method name(s) when wiring CI.)
- **iOS signing: fastlane match** (encrypted git repo of certs/profiles). Chosen because (a) TestFlight upload needs fastlane anyway, (b) multi-dev onboarding, (c) two+ bundle IDs/configs.
- **iOS delivery: TestFlight** via `fastlane pilot`. Needs App Store Connect API key: `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY` (.p8, base64). Testers' experience unchanged (install via TestFlight app).
- **Runners**: start GitHub-hosted (`ubuntu-latest` Android, `macos-latest` iOS); self-hosted mac mini later only if minutes cost bites.

### Hosted MCP platform
- Single endpoint, **Google OAuth + email allowlist** (add email → user signs in with Google → access). Server holds least-privilege service accounts per upstream service. **Audit log** every tool call (email, tool, args, timestamp) — add early, painful to retrofit.
- Onboarding win: non-engineer teammates get one MCP URL + Google sign-in, instead of local SSH keys + N service-account configs.

### Hosting (DEFERRED — revisit at phase 3)
- Leaning **Hetzner CX22** (2 vCPU, 4 GB RAM, ~€5/mo) — Docker workload needs >1 GB; Hetzner gives 4× a Linode Nanode at same price.
- **Caddy + Docker Compose** for reproducibility ("oneclick copy": whole server = one folder, `rsync` + `docker compose up -d`). Replaces nginx, which was hard to copy.
- DNS at **Namecheap**; `mcp.<domain>` → server IP (subdomain CNAME/A; apex stays on existing site).
- Considered & rejected: Fly.io (nice DX but per-app model fights a multi-service Daemon system; bills can surprise), Linode (familiar but Nanode too small for Docker, pricier for 4 GB), Namecheap shared hosting (Passenger/SSE limits make it unsuitable), Namecheap VPS (works but less mature than Linode/Hetzner).

## Tech stack
- **MCP server + jobs + lib**: TypeScript, pnpm workspaces.
- **CI**: GitHub Actions YAML + GameCI.
- **iOS automation**: fastlane (Ruby).
- **Reverse proxy**: Caddy. **Orchestration**: Docker Compose.
- **Agents**: Claude agent definition files.
- **Notification**: Telegram.

## Open decisions
1. **Server host**: Hetzner (leaning) vs Linode vs other. (Only blocks phase 3.)
2. **Domain** for the `mcp.` subdomain.

### Resolved
- **Notification channel**: **Telegram** (bot token + chat ID; one-curl send, strong mobile push). Shared `lib/notify`.
- **MCP/jobs language**: **TypeScript** (pnpm workspaces; official MCP SDK is TS-first).
- **Repo visibility**: **public** (daemonica org) — for cross-org sharing; all secrets stay in consuming repos / on the server.

## Git conventions (match the user's established preference)
- Commit messages: single subject line, no body unless explicitly asked.
- Do NOT add `Co-Authored-By` lines.

## Cross-project context
- **Sway is pivoting** from a WordGame fork into a drawing/stroke-recognition game ($1 unistroke recognizer, stroke capture, HUD). Its own CLAUDE.md describes the in-progress cleanup.
- This repo's automation must serve **both** WordGame and Sway from day one — keep tools parameterized by project (e.g. Firebase project ID, bundle ID) rather than hardcoded to one game.
