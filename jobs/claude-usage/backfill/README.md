# Backfilling the archive into Prometheus

**This is the recovery path, not the routine one.** The nightly job now publishes each finished day
over OTLP as it happens (see the parent README), so this is only for days that fell past Prometheus'
`out_of_order_time_window` — a laptop off for longer than a week, or a range that predates the job.
Everything here still works; you should just rarely need it.

Prometheus rejects samples with old timestamps — its OTLP receiver is built for live systems and
out-of-order ingestion is off by default. So historical days cannot be *pushed*; they have to be
written as TSDB blocks directly, which is what `promtool tsdb create-blocks-from openmetrics` does.

The result is two clearly separate series rather than one continuous metric:

| Metric | Source | Type |
|--------|--------|------|
| `claude_code_*` | live OTLP from Claude Code | counters |
| `claude_usage_archive_daily_*` | this archive, from transcripts | gauges |

They are kept apart on purpose. A counter is a running total and Prometheus derives rates from how
much it *increased*; feeding daily sums into one produces a sawtooth that `rate()` reads as constant
resets. The two also differ in provenance and granularity, and a chart should say so rather than
pretend otherwise.

## Procedure

Run once, then again only if you want to extend the range.

**1. Generate (on your Mac)**

```sh
node jobs/claude-usage/backfill/to-openmetrics.mjs > /tmp/archive.om
scp /tmp/archive.om ADMIN@SERVER:/opt/daemon-tools/archive.om
```

Refresh the archive first (`node jobs/claude-usage/dist/index.js`) if it is stale — it only covers
days it has seen.

**2. Write the blocks (on the server)**

Prometheus must be stopped: promtool writes into the same data directory, and a running server
compacting underneath it is asking for trouble.

```sh
cd /opt/daemon-tools
docker volume ls | grep prometheus          # confirm the volume name (project prefix + _prometheus_data)

docker compose stop prometheus
docker run --rm \
  --entrypoint promtool \
  -v /opt/daemon-tools/archive.om:/tmp/archive.om:ro \
  -v daemon-tools_prometheus_data:/prometheus \
  prom/prometheus:v3.1.0 \
  tsdb create-blocks-from openmetrics /tmp/archive.om /prometheus
docker compose start prometheus
```

`--entrypoint promtool` is required: the image's entrypoint is `prometheus`, so passing `promtool`
as a command argument gets handed to the server instead (`unexpected promtool`).

The one-off container runs as the image's own `nobody` user, so the blocks it writes are owned by
the same uid Prometheus runs as — don't add `--user root`, or Prometheus will fail to read what it
just gained.

**3. Verify**

```sh
docker compose exec prometheus wget -qO- \
  'http://localhost:9090/api/v1/query?query=count(claude_usage_archive_daily_tokens)'
```

Then in Grafana, query `claude_usage_archive_daily_tokens` over a range that includes the archived
dates. Remember the dashboard defaults to 30 days — widen it to see the full history.

**4. Clean up**

```sh
rm /opt/daemon-tools/archive.om
```

## Re-running

Blocks are additive, so importing an overlapping range twice leaves duplicate samples for those
days. Prometheus tolerates it (identical samples deduplicate on query), but if you extend the range
later, prefer regenerating from a fresh archive and importing only the new window rather than the
whole file again.
