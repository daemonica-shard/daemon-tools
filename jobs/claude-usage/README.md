# claude-usage

Archives Claude Code token usage before Claude Code deletes it, and posts a weekly summary to
Telegram.

## Why

On a Max plan there is no billing page to read, so the only record of what you actually consumed is
the session transcripts under `~/.claude/projects/**/*.jsonl` — and those are pruned on
`cleanupPeriodDays` (30 by default). [`ccusage`](https://github.com/ryoppippi/ccusage) reads them
and reports beautifully, but it can only ever see the surviving window: run it in December and your
June is simply gone.

This job runs ccusage on a schedule and merges each report into a permanent archive, so the window
slides but the history accumulates.

`/usage` inside Claude Code remains the authority on **plan limits** (the 5-hour and weekly windows).
This job measures **tokens**, which is a different question — the two will not agree, and neither is
wrong.

## What it does

1. Shells out to `npx ccusage daily --json`.
2. Merges the result into `~/.claude-usage/archive.json`, keyed by date.
3. With `--digest`, formats the last 7 days and sends it to Telegram.

The merge takes the **larger** reading for any day it already holds. A day inside the window can
only grow as you work; a day that has aged out vanishes from the report rather than returning
smaller — so max is what preserves pruned history.

## Scope

Local to the machine it runs on. It reads *this* Mac's transcripts, and only while the machine is
awake. Claude Code usage from another laptop, or from the web app, is invisible to it. If you need
usage aggregated across machines, that is the OpenTelemetry path (`deploy/` — Prometheus + Grafana),
not this.

## Usage

```sh
pnpm --filter claude-usage build

node dist/index.js                 # refresh the archive
node dist/index.js --digest        # refresh, then send to Telegram
node dist/index.js --dry-run       # print the digest instead of sending
node dist/index.js --days 30       # widen the digest window
```

| Variable | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Same bot as the CI build notifications. Unset → digest skipped, not failed. |
| `TELEGRAM_CHAT_ID` | Target chat. Unset → digest skipped. |
| `CLAUDE_USAGE_ARCHIVE` | Archive path. Default `~/.claude-usage/archive.json`. |
| `CCUSAGE_SPEC` | npx spec for ccusage. Default `ccusage@latest`; pin here if a release breaks the JSON shape. |

The archive lives outside the repo on purpose — **this repo is public**, and the archive is a record
of your personal working hours.

## Scheduling (macOS)

```sh
REPO=$(git rev-parse --show-toplevel)

# Secrets and PATH in one 600 file, so they stay out of the plists.
mkdir -p ~/.claude-usage
cat > ~/.claude-usage/env <<EOF
PATH=$(dirname "$(which node)"):/usr/bin:/bin
NODE=$(which node)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
EOF
chmod 600 ~/.claude-usage/env

chmod +x "$REPO/jobs/claude-usage/launchd/run.sh"

for job in archive digest; do
  sed -e "s#REPO#$REPO#g" -e "s#HOME#$HOME#g" \
    "$REPO/jobs/claude-usage/launchd/com.daemonica.claude-usage.$job.plist" \
    > ~/Library/LaunchAgents/com.daemonica.claude-usage.$job.plist
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.daemonica.claude-usage.$job.plist
done
```

Archive runs nightly at 03:10; digest goes out Monday at 09:00. Unlike cron, launchd runs a missed
calendar interval when the machine next wakes, so a sleeping laptop does not silently skip nights.

**`PATH` matters.** launchd gives an agent almost no environment: no shell profile, so no nvm, so
neither `node` nor the `npx` this job shells out to. That is what the env file is for. If you switch
Node versions with nvm, update it.

Check on it:

```sh
launchctl list | grep claude-usage      # second column is the last exit status; 0 is good
tail -f ~/Library/Logs/claude-usage.log
launchctl kickstart -p "gui/$(id -u)/com.daemonica.claude-usage.digest"   # force a run now
```

To remove:

```sh
for job in archive digest; do
  launchctl bootout "gui/$(id -u)/com.daemonica.claude-usage.$job"
  rm ~/Library/LaunchAgents/com.daemonica.claude-usage.$job.plist
done
```

## Tests

```sh
pnpm --filter claude-usage test
```

Covers the merge rule (including that pruned days survive) and digest formatting. The ccusage call
itself is not mocked — it is one `execFile` with a JSON parse, and mocking it would test the mock.
