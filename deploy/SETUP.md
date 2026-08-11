# New server, from zero

Chronological runbook for standing up a fresh MCP host. `deploy/README.md` is the reference for
routine operations once it's running; this file is the one-time bootstrap.

Written from the OVH + Ubuntu 26.04 build, but nothing here is OVH-specific except where noted.
Gotchas we actually hit are called out — they cost real time.

Placeholders: `SERVER_IP`, `ADMIN` (your account, e.g. `daemonica`), `DOMAIN`.

---

## 1. Provision the VPS

Entry-tier VPS is enough: 2 vCore / 4 GB / 40 GB, x86 (**not** ARM — CI builds x86 images).
Ubuntu LTS, no control panel.

- **OVH:** the VPS product lives under **Bare Metal Cloud**, not Public Cloud. Public Cloud is the
  metered AWS-style platform (Kubernetes, object storage, vRack) — 3× the price and not what we want.
  Decline vRack, extra IPs, and any managed options. Take the free automated backup if offered.
- Attach an SSH key during ordering if the form allows; otherwise the provider emails a password.

## 2. Keys (on your Mac)

Two keys, two purposes: one is yours, one is CI's. Never reuse a key that already has another job.

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_daemonica_server -C "you@daemon-server"
ssh-keygen -t ed25519 -f ~/.ssh/id_daemonica_deploy -N "" -C "github-actions@daemon-tools"
```

`-N ""` on the deploy key: CI cannot answer a passphrase prompt.

Add to `~/.ssh/config` — `IdentitiesOnly` stops ssh offering every key you own to every host
(servers cap auth attempts, so a long key list can get you rejected before the right one is tried):

```
Host daemon
  HostName SERVER_IP
  User ADMIN
  IdentityFile ~/.ssh/id_daemonica_server
  IdentitiesOnly yes

Host *
  AddKeysToAgent yes
  UseKeychain yes
```

## 3. Admin user

**Gotcha:** OVH images disable root and ship a default user (`ubuntu`). Don't enable root, and
don't rename the default user in place — a half-finished `usermod -l` on the only sudo account of a
rootless box locks you out. Create a new user, verify it, then delete the old one.

```sh
# on the server, as the provider's default user
sudo adduser ADMIN
sudo usermod -aG sudo ADMIN

sudo mkdir -p /home/ADMIN/.ssh
sudo nano /home/ADMIN/.ssh/authorized_keys      # paste id_daemonica_server.pub
sudo chown -R ADMIN:ADMIN /home/ADMIN/.ssh
sudo chmod 700 /home/ADMIN/.ssh
sudo chmod 600 /home/ADMIN/.ssh/authorized_keys
```

Verify **from a second terminal**, keeping the first session open:

```sh
ssh daemon
sudo whoami        # must print: root
```

Only then:

```sh
sudo deluser --remove-home ubuntu
```

## 4. Disable password authentication

The single highest-value hardening step: port 22 on a public IP is brute-forced within hours.

**Gotcha:** editing `/etc/ssh/sshd_config` alone usually does nothing. Ubuntu cloud images include
drop-ins, sshd takes the **first** value it obtains, and the drop-in directory is read first — so
`50-cloud-init.conf`'s `PasswordAuthentication yes` beats both the main file and a later `60-`
drop-in. Fix with a file that sorts **before 50**.

```sh
sudo grep -r PasswordAuthentication /etc/ssh/sshd_config /etc/ssh/sshd_config.d/

printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' \
  | sudo tee /etc/ssh/sshd_config.d/01-hardening.conf

sudo sshd -t                            # validate BEFORE restarting
sudo systemctl restart ssh
sudo sshd -T | grep -i passwordauth     # must now say: no
```

Confirm from your Mac — expect `Permission denied (publickey)`:

```sh
ssh -o PubkeyAuthentication=no ADMIN@SERVER_IP
```

## 5. System + Docker

```sh
sudo apt update && sudo apt upgrade -y
sudo apt install -y fail2ban unattended-upgrades
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
sudo reboot                             # new kernel + docker group needs a fresh session
```

After reconnecting:

```sh
docker run --rm hello-world             # no sudo = group membership works
```

`unattended-upgrades` defaults are conservative: security patches only, never auto-reboots.

Note: `docker` group membership is effectively root (you can mount the host filesystem into a
container). The SSH key is the real security boundary on this box, not sudo.

## 6. Deploy user for CI

A machine account, separate from yours, so its key — which lives in GitHub's secret store — can be
revoked without touching your access. It gets docker group, **not** sudo.

```sh
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo mkdir -p /home/deploy/.ssh
sudo nano /home/deploy/.ssh/authorized_keys     # paste id_daemonica_deploy.pub
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

Verify from your Mac — an empty container table means CI's exact path works:

```sh
ssh -i ~/.ssh/id_daemonica_deploy deploy@SERVER_IP docker ps
```

## 7. Stack directory + sync

```sh
# server
sudo mkdir -p /opt/daemon-tools
sudo chown "$USER:$USER" /opt/daemon-tools

# Mac, from the repo root — trailing slash on deploy/ is required
rsync -av deploy/ ADMIN@SERVER_IP:/opt/daemon-tools/
```

Re-runnable and non-destructive: without `--delete`, server-only files (`.env`, `config/`) survive
every re-sync.

## 8. Config

```sh
cd /opt/daemon-tools
cp .env.example .env
nano .env                               # DOMAIN=DOMAIN  GHCR_OWNER=<github owner, lowercase>
mkdir -p config/prod/firebase config/dev/firebase
```

Generate tokens on your Mac (`pnpm keygen`), one run per person/machine; paste the **hash** into
`tenants.yaml`, keep the **token** in a password manager. See `config/tenants.example.yaml`.
Service-account JSONs go up separately:

```sh
scp path/to/firebase-sa.json ADMIN@SERVER_IP:/opt/daemon-tools/config/prod/firebase/PROJECT-sa.json
```

**Gotcha:** the image runs as `node` = uid 1000; your admin account is likely uid 1001 (cloud-init
took 1000 for the default user you deleted). Files owned by 1001 with mode 600 are unreadable to
the container, which crash-loops with `EACCES`. Ownership must follow the container, not you:

```sh
sudo chmod 755 config config/prod config/dev config/*/firebase
sudo chown 1000:1000 config/*/firebase/*.json
sudo chmod 600 config/*/firebase/*.json    # secret: only the container can read it
chmod 644 config/*/tenants.yaml            # hashes only, not secret
```

## 9. DNS

A records at the registrar, all → `SERVER_IP`, lowest available TTL while setting up. Caddy asks
Let's Encrypt for a certificate per hostname on first request, so a name that does not resolve is a
service that never starts serving:

| Type | Host | Value | For |
|------|---------|-------------|-----|
| A | `@` | `SERVER_IP` | landing page |
| A | `mcp` | `SERVER_IP` | MCP (prod) |
| A | `dev.mcp` | `SERVER_IP` | MCP (dev) |
| A | `auth` | `SERVER_IP` | Keycloak |
| A | `grafana` | `SERVER_IP` | dashboards |
| A | `otel` | `SERVER_IP` | metrics ingest |

**Gotcha:** delete the registrar's default parking records first — Namecheap ships a URL Redirect
Record on `@` and a `www` CNAME to its parking page, and a redirect record can't coexist with an A
record on the same host.

Verify before starting Caddy:

```sh
dig +short DOMAIN mcp.DOMAIN dev.mcp.DOMAIN
```

## 10. Start

**Gotcha:** `:prod` does not exist until you promote something, so a plain `docker compose up -d`
fails on the `mcp` service. Start what exists first:

```sh
cd /opt/daemon-tools
docker compose up -d caddy mcp-dev
docker compose logs -f caddy            # watch for "certificate obtained successfully"
```

Certificates are automatic. Expect scanner traffic within minutes — Certificate Transparency logs
are public and bots watch them for new domains. Probes for `/.env` and `/.git/config` are normal
and reach nothing: the MCP hosts only reverse-proxy, they serve no files.

## 11. GitHub secrets + first promote

Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | `SERVER_IP` |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | `pbcopy < ~/.ssh/id_daemonica_deploy` (private key, whole file) |

Then Actions → **Deploy MCP** → Run workflow → `promote` = a full image tag, e.g.
`sha-<40-char-commit-sha>`. Promotion retags the exact image dev ran; it never rebuilds. Prefer a
`sha-` tag over `dev`, which moves under you.

```sh
docker compose up -d                    # all three, now that :prod exists
```

## 12. Verify end to end

```sh
curl https://mcp.DOMAIN/healthz

curl -s -X POST https://mcp.DOMAIN/<tenant>/mcp \
  -H "Authorization: Bearer dmt_..." \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

Then register with a client:

```sh
claude mcp add --transport http <name> https://mcp.DOMAIN/<tenant>/mcp \
  -s user --header "Authorization: Bearer dmt_..."
```

---

## 13. Keycloak — the Google-sign-in tier (optional)

Only needed for non-engineers. API keys work without any of this, and the MCP server ignores
OIDC entirely unless `OIDC_ISSUER` and `PUBLIC_URL` are both set.

Keycloak is the **authorization server**; our MCP servers are only resource servers that verify
its tokens. We never touch Google directly — Keycloak federates that.

### 13.1 DNS + secrets

The `auth` A record from step 9 must resolve before Keycloak can get a certificate. Then in `.env`:

```sh
KC_REALM=daemonica
KC_ADMIN_USER=admin
KC_ADMIN_PASSWORD=$(openssl rand -base64 24)     # your login to the Keycloak admin console
KC_DB_PASSWORD=$(openssl rand -base64 32)        # Keycloak ↔ Postgres only, never typed by a human
```

`KC_ADMIN_*` is a **bootstrap** account. After first login, create a real admin user in the
master realm and disable this one — the admin console is internet-facing.

### 13.2 Google OAuth client

Google Cloud Console → **APIs & Services → Credentials → Create OAuth client ID → Web
application**. Authorized redirect URI:

```
https://auth.DOMAIN/realms/KC_REALM/broker/google/endpoint
```

Any Google account can create this. On the consent screen, **User Type**:

- **Internal** — only available with Google Workspace; restricted to your org, no verification.
- **External** — required for personal Gmail. Publish it rather than leaving it in *Testing*:
  testing-mode refresh tokens expire after 7 days, so users would re-authenticate weekly.
  Publishing is not gated on Google's review process for basic `email`/`profile` scopes —
  verification applies to sensitive and restricted scopes, which we don't request.

Google only proves *who* someone is. Whether they get in is decided by `allow_emails` in
`tenants.yaml`, so a permissive Google config is fine.

### 13.3 Start it

```sh
docker compose up -d keycloak-db keycloak
docker compose logs -f keycloak      # first boot runs schema migrations, ~30s
```

Then sign in at `https://auth.DOMAIN/admin`.

### 13.4 Realm + Google identity provider

1. Create a realm named to match `KC_REALM` — it becomes part of the issuer URL, so renaming it
   later invalidates every connected client.
2. **Identity Providers → Google** → paste the Client ID and Secret from 13.2.

### 13.5 Audience binding — required, and easy to miss

Keycloak does not implement the MCP spec's `resource` parameter, so tokens must be
audience-bound through a scope instead. Without this, our servers reject every token (they
verify `aud` against their own public URL).

Per MCP host: **Client scopes → Create client scope** (e.g. `mcp:tools`, type *Optional*) →
**Mappers → Configure a new mapper → Audience** → set **Included Custom Audience** to that
host's URL:

| Scope | Included Custom Audience |
|-------|--------------------------|
| for prod | `https://mcp.DOMAIN` |
| for dev | `https://dev.mcp.DOMAIN` |

### 13.6 Client registration for Claude

MCP clients register themselves rather than being pre-created, since nobody hands a designer a
client ID. Keycloak supports MCP 2025-03-26 with **no registration setup at all**, so try
connecting a client before configuring anything here — you may not need it.

If a client fails at the registration step, the mechanism is Dynamic Client Registration
(RFC 7591), which Keycloak has supported for years: **Realm Settings → Client registration →
Anonymous access policies**. Loosen those policies only as far as a client actually requires.

**Not available on 26.4:** Keycloak's MCP guide also describes Client ID Metadata Document
(CIMD) registration behind `--features=cimd`. That flag does not exist in 26.4 — passing it
makes Keycloak refuse to start with `cimd is an unrecognized feature`. It belongs to a later
release; check `--features=help` for what the running version actually offers before enabling
anything from that guide.

### 13.7 Grant access, export, verify

Add emails to the tenant in `config/prod/tenants.yaml`:

```yaml
tenants:
  tapempire:
    allow_emails:
      - designer@example.com
```

then `docker compose restart mcp`.

**Export the realm** so the database stays a cache rather than the only copy:

```sh
docker compose exec keycloak /opt/keycloak/bin/kc.sh export \
  --dir /tmp/realm --realm KC_REALM
docker compose cp keycloak:/tmp/realm ./config/keycloak-realm
```

Keep that with the rest of `config/` in your encrypted backup. Verify the metadata document
points where it should:

```sh
curl https://mcp.DOMAIN/.well-known/oauth-protected-resource
```

Then add the connector in Claude Desktop or claude.ai using just the URL — the 401 carries
`resource_metadata`, which is what makes the browser sign-in appear.

---

## 14. Metrics — Prometheus + Grafana (optional)

Claude Code can push token/cost telemetry over OTLP. Prometheus stores it; Grafana draws it. There
is no collector in between — Prometheus ingests OTLP directly, so a collector would only forward.

Worth being clear about what this is *not*: it measures **tokens**, while a Max plan is metered on
rate-limit windows. `/usage` inside Claude Code remains the only authority on how much of your plan
you have consumed. These two numbers will not agree and neither is wrong.

It also only sees machines you configure, from the day you configure them. For history that already
happened, `jobs/claude-usage` reads the local transcripts instead.

### 14.1 DNS + secrets

`grafana` and `otel` A records from step 9. Then in `.env`:

```sh
OTEL_INGEST_TOKEN=$(openssl rand -hex 32)        # one shared value, all clients
GRAFANA_ADMIN_PASSWORD=$(openssl rand -base64 24)
GRAFANA_OIDC_SECRET=                             # filled in 14.2
```

### 14.2 Grafana client in Keycloak

Requires step 13. **Clients → Create client**:

| Field | Value |
|-------|-------|
| Client ID | `grafana` |
| Client authentication | On (confidential) |
| Valid redirect URIs | `https://grafana.DOMAIN/login/generic_oauth` |
| Web origins | `https://grafana.DOMAIN` |

**Credentials → Client secret** → paste into `GRAFANA_OIDC_SECRET`.

Everyone who signs in lands as **Viewer**. Promote yourself with the local `admin` account
(`https://grafana.DOMAIN/login` — the form is still there) → Administration → Users.

### 14.3 Start

```sh
docker compose up -d prometheus grafana
docker compose logs -f grafana        # provisioning errors surface here, not in the UI
```

### 14.4 Point Claude Code at it

Per machine, in `~/.claude/settings.json` — so it applies to every session without touching shell
profiles:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.DOMAIN/api/v1/otlp",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer OTEL_INGEST_TOKEN",
    "OTEL_METRICS_INCLUDE_SESSION_ID": "false"
  }
}
```

Three settings that are load-bearing:

- **Do not set `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`.** Prometheus needs
  cumulative counters; delta silently produces flat panels rather than an error.
- **`OTEL_METRICS_INCLUDE_SESSION_ID=false`.** Session ID is unbounded — left on, every session
  creates a permanent new time series and the database grows without limit.
- **Leave `OTEL_LOG_USER_PROMPTS` unset.** It is off by default, and prompt text from a work
  machine does not belong in a metrics store.

### 14.5 Verify

```sh
# Unauthenticated ingest must be refused, and the query API must not be routed at all.
curl -s -o /dev/null -w 'ingest without token: %{http_code}\n' https://otel.DOMAIN/api/v1/otlp/v1/metrics
curl -s -o /dev/null -w 'query API: %{http_code}\n' https://otel.DOMAIN/api/v1/query?query=up
```

Both should be `401`. Then run a Claude Code session, wait one export interval (60s), and check the
names actually landed:

```sh
docker compose exec prometheus wget -qO- \
  'http://localhost:9090/api/v1/label/__name__/values' | tr ',' '\n' | grep claude
```

Expect `claude_code_token_usage_tokens_total` and friends. **If the names differ, fix the dashboard
rather than assuming it is broken** — OTLP-to-Prometheus name translation (dots to underscores,
unit appended, `_total` for counters) is the part most likely to shift between versions, and the
dashboard in `deploy/grafana/provisioning/dashboards/` hardcodes the expected spelling.

---

## Afterwards

- **Back up `config/` off the server, encrypted.** Everything else redeploys from git + GHCR;
  `tenants.yaml` and the service-account keys exist nowhere else.
- Volumes created before the image gained its `/data` ownership fix stay root-owned. On a server
  built from an older image: `docker compose exec -u root mcp chown node:node /data`.
