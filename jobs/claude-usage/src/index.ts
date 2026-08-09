#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { load, merge, save } from "./archive.js";
import { fetchDaily } from "./ccusage.js";
import { compact, formatDigest, sum } from "./digest.js";
import { sendTelegram } from "./notify.js";

const USAGE = `claude-usage — archive Claude Code token usage before the transcripts are pruned

  claude-usage                 refresh the archive (nightly)
  claude-usage --digest        refresh, then post a summary to Telegram (weekly)

Options:
  --days N        digest window in days (default 7)
  --archive PATH  archive location (default ~/.claude-usage/archive.json,
                  or $CLAUDE_USAGE_ARCHIVE)
  --dry-run       print the digest instead of sending it
  -h, --help      this message
`;

interface Options {
  digest: boolean;
  days: number;
  archivePath: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const defaultPath = process.env.CLAUDE_USAGE_ARCHIVE ?? join(homedir(), ".claude-usage", "archive.json");
  const options: Options = { digest: false, days: 7, archivePath: defaultPath, dryRun: false };

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
      case "-h": case "--help": process.stdout.write(USAGE); process.exit(0);
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);

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

  if (!options.digest) return;

  const text = formatDigest(after, today, options.days);
  if (options.dryRun) {
    console.log(`\n${text}`);
    return;
  }
  console.log(await sendTelegram(text) ? "digest sent to Telegram" : "digest skipped (Telegram secrets unset)");
}

main().catch((err: unknown) => {
  console.error(`claude-usage: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
