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

Three A records at the registrar, all → `SERVER_IP`, lowest available TTL while setting up:

| Type | Host | Value |
|------|---------|-------------|
| A | `@` | `SERVER_IP` |
| A | `mcp` | `SERVER_IP` |
| A | `dev.mcp` | `SERVER_IP` |

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

## Afterwards

- **Back up `config/` off the server, encrypted.** Everything else redeploys from git + GHCR;
  `tenants.yaml` and the service-account keys exist nowhere else.
- Volumes created before the image gained its `/data` ownership fix stay root-owned. On a server
  built from an older image: `docker compose exec -u root mcp chown node:node /data`.
