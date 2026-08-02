# Server deployment

The entire server is this folder. Reproducing it anywhere = rsync + fill in two gitignored
pieces (`.env`, `config/`) + `docker compose up -d`.

## First-time server setup (Hetzner CX22, Ubuntu)

Root login is disabled on OVH images; everything below runs as your sudo user.

```sh
# on the server
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo mkdir -p /opt/daemon-tools
sudo chown "$USER:$USER" /opt/daemon-tools    # so rsync can write without sudo

# from your machine
rsync -av deploy/ USER@SERVER:/opt/daemon-tools/

# on the server
cd /opt/daemon-tools
cp .env.example .env            # set DOMAIN + GHCR_OWNER
mkdir -p config/prod config/dev # tenants.yaml + firebase SA jsons per environment
docker compose up -d
```

DNS at the registrar: A records for `@`, `mcp`, `dev.mcp` → server IP. Caddy fetches TLS
certificates automatically once DNS resolves.

## Config layout (server-only, never in git)

```
config/
  prod/
    tenants.yaml            # tenants, key hashes, tool wiring (see /config/tenants.example.yaml)
    firebase/*-sa.json      # service accounts referenced by tenants.yaml
  dev/
    tenants.yaml
    firebase/*-sa.json
```

Containers see their config dir as `/config`, so paths inside tenants.yaml are like
`/config/firebase/wordgame-sa.json`. Audit logs persist in named volumes (`/data/audit.jsonl`).

## Images

Built and pushed by `.github/workflows/deploy-mcp.yml`:

- `ghcr.io/<owner>/daemon-tools-mcp:dev` — every trunk push touching mcp-server/lib; auto-deployed to `dev.mcp.<domain>`
- `ghcr.io/<owner>/daemon-tools-mcp:prod` — promoted manually via workflow_dispatch
- `:sha-<commit>` — every build, for pinning/rollback

NOTE: the first push creates the GHCR package as **private**. Make it public once
(GitHub → org → Packages → daemon-tools-mcp → settings) so the server can pull anonymously.

## Routine operations

- Add a person/key: `pnpm keygen` locally → paste hash into `config/<env>/tenants.yaml` → `docker compose restart mcp` (or `mcp-dev`)
- Rollback: `docker compose pull` a pinned `:sha-...` tag (edit compose or retag) → `up -d`
- Logs: `docker compose logs -f mcp` · audit trail: `docker compose exec mcp cat /data/audit.jsonl`
