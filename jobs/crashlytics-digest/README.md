# crashlytics-digest

Summarises recent Crashlytics issues for every linked app and posts them to Pachca/Telegram.

## Why

The Crashlytics console answers "what is broken" well, but only when someone opens it. This turns
the same data into a message that arrives whether or not anyone remembers to look, and ranks it the
way triage actually works.

## What it does

1. Lists the export's **batch** tables (one per app/platform) and queries each one.
2. Splits issues into **new** (first seen inside the window) and **ongoing**.
3. Ranks by **affected installs, not events** — one device in a crash loop can generate more events
   than a bug hitting a hundred users. Loops are flagged rather than hidden: `[loop: 45 events]`.
4. Adds a per-version line so a bad release is visible next to the issue list.
5. Sends via `@daemon-tools/notify`; unconfigured channels are skipped, not failed.

## Batch, not realtime

The export creates two tables per app. `--realtime` reads the streaming ones, but the default is
the batch tables, deliberately:

| | batch | `_REALTIME` |
|---|---|---|
| latency | daily | ~1 hour |
| backfill | up to 30 days | none |
| retention | kept | partitions expire after 30 days |

A digest reports on a window, so it wants the table that has the window. Realtime is for watching
the current partial day.

Note that a freshly linked export has **no batch table at all** for up to 48 hours — only realtime.
The job prints `no Crashlytics tables found` and exits cleanly in that state rather than failing.

## Usage

```sh
pnpm --filter crashlytics-digest build

node dist/index.js                    # last 24h, every linked app
node dist/index.js --dry-run          # print instead of sending
node dist/index.js --days 7 --limit 3 # weekly, shorter lists
node dist/index.js --table com_tapempire_wordgame_ANDROID
node dist/index.js --realtime         # current partial day
```

| Variable | Meaning |
|---|---|
| `CRASHLYTICS_PROJECT` | GCP project holding the export. |
| `CRASHLYTICS_SERVICE_ACCOUNT` | Path to the service account JSON. Same credential the MCP server's Crashlytics tool uses. |
| `CRASHLYTICS_LOCATION` | BigQuery region, e.g. `me-central1`. Required — BigQuery defaults to US and fails with a "not found" that reads like a permissions problem. |
| `CRASHLYTICS_DATASET` | Default `firebase_crashlytics`. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Unset → Telegram skipped, not failed. |
| `PACHCA_WEBHOOK_URL` | Unset → Pachca skipped. |

## Where the queries live

In `@daemon-tools/crashlytics`, not here — the MCP server's `crashlytics` tool asks the export the
same questions, and a second copy of that SQL would drift from the first the moment either was
tuned. This job owns the formatting and the schedule; the library owns the queries.
