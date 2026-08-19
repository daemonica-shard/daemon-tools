#!/usr/bin/env node
import { CrashlyticsClient } from "@daemon-tools/crashlytics";
import { configFromEnv, send } from "@daemon-tools/notify";
import { formatDigest, type AppReport } from "./digest.js";

const USAGE = `crashlytics-digest — summarise recent Crashlytics issues and post them to chat

  crashlytics-digest                 digest the last 24h of every linked app
  crashlytics-digest --dry-run       print it instead of sending
  crashlytics-digest --days 7        widen the window

Options:
  --days N        window in days (default 1)
  --limit N       issues listed per app, per section (default 5)
  --table NAME    restrict to one table; repeatable (default: every batch table)
  --realtime      read the _REALTIME tables instead of the batch ones
  --dry-run       print the digest instead of sending it
  -h, --help      this message

Environment:
  CRASHLYTICS_PROJECT           GCP project holding the export
  CRASHLYTICS_SERVICE_ACCOUNT   path to the service account JSON
  CRASHLYTICS_LOCATION          BigQuery region, e.g. me-central1
  CRASHLYTICS_DATASET           default firebase_crashlytics
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / PACHCA_WEBHOOK_URL
                                unset channels are skipped, not failed
`;

// Fetched deeper than displayed: the digest splits issues into new and ongoing, and a shallow
// fetch would hide every ongoing issue behind a burst of new ones.
const FETCH_LIMIT = 40;

interface Options {
  days: number;
  limit: number;
  tables: string[];
  realtime: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { days: 1, limit: 5, tables: [], realtime: false, dryRun: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    const positive = (raw: string, name: string) => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
      return n;
    };
    switch (arg) {
      case "--days": options.days = positive(next(), "--days"); break;
      case "--limit": options.limit = positive(next(), "--limit"); break;
      case "--table": options.tables.push(next()); break;
      case "--realtime": options.realtime = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "-h": case "--help": process.stdout.write(USAGE); process.exit(0);
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const crashlytics = new CrashlyticsClient({
    projectId: required("CRASHLYTICS_PROJECT"),
    serviceAccountPath: required("CRASHLYTICS_SERVICE_ACCOUNT"),
    location: required("CRASHLYTICS_LOCATION"),
    dataset: process.env.CRASHLYTICS_DATASET,
  });

  let tables = options.tables;
  if (!tables.length) {
    tables = options.realtime
      ? (await crashlytics.listTables()).filter((t) => t.endsWith("_REALTIME"))
      : await crashlytics.batchTables();
  }
  if (!tables.length) {
    // An export that has never received an event has no tables at all, which is a real state and
    // not a failure — it is what this looked like for the two days after linking.
    console.log("no Crashlytics tables found — nothing to digest");
    return;
  }

  const reports: AppReport[] = [];
  for (const table of tables) {
    const [crashes, versions] = await Promise.all([
      crashlytics.topCrashes({ table, days: options.days, limit: FETCH_LIMIT }),
      crashlytics.crashesByVersion({ table, days: options.days }),
    ]);
    reports.push({ table, crashes, versions });
  }

  const text = formatDigest(reports, { days: options.days, now: new Date(), limit: options.limit });

  if (options.dryRun) {
    console.log(`\n${text}`);
    return;
  }

  const results = await send(text, configFromEnv());
  const delivered = results.filter((r) => r.sent).map((r) => r.channel);
  // Single stdout line so a cron log stays readable at a glance.
  console.log(
    `digested ${tables.length} table(s), ${reports.reduce((n, r) => n + r.crashes.length, 0)} issues → ` +
      (delivered.length ? delivered.join(", ") : "no channel configured"),
  );
}

main().catch((err: unknown) => {
  console.error(`crashlytics-digest: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
