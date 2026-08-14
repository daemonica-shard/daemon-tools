#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { load, merge, save } from "./archive.js";
import { fetchDaily } from "./ccusage.js";
import { compact, formatDigest, sum } from "./digest.js";
import { configFromEnv, send } from "@daemon-tools/notify";
import { localDate, publish } from "./publish.js";

const USAGE = `claude-usage — archive Claude Code token usage before the transcripts are pruned

  claude-usage                 refresh the archive, publish finished days (nightly)
  claude-usage --digest        also post a summary to Telegram (weekly)

Options:
  --days N        digest window in days (default 7)
  --archive PATH  archive location (default ~/.claude-usage/archive.json,
                  or $CLAUDE_USAGE_ARCHIVE)
  --dry-run       print the digest instead of sending it
  --no-publish    refresh the archive only, do not push to Prometheus
  --publish-since YYYY-MM-DD
                  publish from this day on, for a deliberate catch-up. Only days
                  Prometheus does not already hold — the dashboard's totals sum every
                  sample in range, so a day sent twice is counted twice.
  -h, --help      this message
`;

// Must match storage.tsdb.out_of_order_time_window in deploy/prometheus/prometheus.yml. Days older
// than Prometheus will accept are reported and skipped, rather than sent to fail the whole batch.
const WINDOW_DAYS = 7;


interface Options {
  digest: boolean;
  days: number;
  archivePath: string;
  dryRun: boolean;
  publish: boolean;
  publishSince?: string;
}

function parseArgs(argv: string[]): Options {
  const defaultPath = process.env.CLAUDE_USAGE_ARCHIVE ?? join(homedir(), ".claude-usage", "archive.json");
  const options: Options = { digest: false, days: 7, archivePath: defaultPath, dryRun: false, publish: true };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--digest": options.digest = true; break;
      case "--dry-run": options.dryRun = true; options.digest = true; break;
      case "--days": {
        const days = Number(next());
        if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a positive integer");
        options.days = days;
        break;
      }
      case "--archive": options.archivePath = next(); break;
      case "--no-publish": options.publish = false; break;
      case "--publish-since": {
        const since = next();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("--publish-since must be YYYY-MM-DD");
        options.publishSince = since;
        break;
      }
      case "-h": case "--help": process.stdout.write(USAGE); process.exit(0);
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const today = localDate();

  const before = await load(options.archivePath);
  const after = merge(before, await fetchDaily(), new Date().toISOString());
  await save(options.archivePath, after);

  const added = Object.keys(after.days).length - Object.keys(before.days).length;
  const totals = sum(Object.values(after.days));
  // Single stdout line so a cron/launchd log stays readable at a glance.
  console.log(
    `archived ${totals.days} days (${added >= 0 ? "+" : ""}${added} new), ` +
      `${compact(totals.totalTokens)} tokens, $${totals.totalCost.toFixed(2)} → ${options.archivePath}`,
  );

  // After the archive is safely on disk: publishing is the recoverable half (the next run retries
  // whatever Prometheus did not take), while a lost archive write is not recoverable at all.
  if (options.publish) {
    const statePath = join(dirname(options.archivePath), "published.json");
    console.log(
      await publish(after, {
        statePath,
        today,
        windowDays: WINDOW_DAYS,
        since: options.publishSince,
        now: new Date().toISOString(),
      }),
    );
  }

  if (!options.digest) return;

  const text = formatDigest(after, today, options.days);
  if (options.dryRun) {
    console.log(`\n${text}`);
    return;
  }
  const results = await send(text, configFromEnv());
  const delivered = results.filter((r) => r.sent).map((r) => r.channel);
  console.log(delivered.length ? `digest sent to ${delivered.join(", ")}` : "digest skipped (no channel configured)");
}

main().catch((err: unknown) => {
  console.error(`claude-usage: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
