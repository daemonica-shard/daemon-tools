#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AppLovinReporting, LOOKBACK_DAYS } from "@daemon-tools/applovin";
import { sync } from "./sync.js";

const DEFAULT_KEY_FILE = join(homedir(), ".config", "applovin", "report-key");

const USAGE = `applovin-spend: keep a daily history of AppLovin ad spend (the advertiser report)

  applovin-spend pull --out DIR [--since DATE] [--until DATE]

Writes DIR/advertiser/<yyyy-mm-dd>.csv per UTC day: spend, installs (conversions), impressions and
clicks by campaign, country and platform. AppLovin keeps only ${LOOKBACK_DAYS} days and revises recent spend,
so each run fetches the whole window again (the default) and overwrites it. Days that have left the
window keep their last copy, so run it at least monthly to keep history without gaps.

Options:
  --out DIR       a folder outside this repo (the repo is public)
  --since DATE    first UTC day, yyyy-mm-dd (default: the oldest day AppLovin still has)
  --until DATE    last UTC day (default: today)

Environment:
  APPLOVIN_REPORT_KEY        the account's Report Key, or
  APPLOVIN_REPORT_KEY_FILE   a file holding it (default ~/.config/applovin/report-key)
`;

// dist/index.js or src/index.ts, three levels below the repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readKey(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.APPLOVIN_REPORT_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = env.APPLOVIN_REPORT_KEY_FILE || DEFAULT_KEY_FILE;
  const fromFile = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (fromFile) return fromFile;
  throw new Error(`No AppLovin Report Key. Set APPLOVIN_REPORT_KEY, or save it in ${file} (AppLovin dashboard: Account > Keys).`);
}

function date(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name} must be a date like 2026-11-20`);
  }
  return value;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function pull(argv: string[]): Promise<void> {
  let out: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--out") out = next();
    else if (arg === "--since") since = date(next(), arg);
    else if (arg === "--until") until = date(next(), arg);
    else if (arg === "-h" || arg === "--help") return void console.log(USAGE);
    else throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
  }
  if (!out) throw new Error("pull needs --out: a folder outside this repo");
  // pnpm runs scripts from the package folder; INIT_CWD is where the command was typed.
  const dir = resolve(process.env.INIT_CWD ?? process.cwd(), out, "advertiser");
  const rel = relative(REPO_ROOT, dir);
  if (rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`Refusing to write ad spend to ${dir}: it is inside this repo, which is public. Pick a folder outside it.`);
  }
  const now = Date.now();
  until ??= utcDay(now);
  since ??= utcDay(now - (LOOKBACK_DAYS - 1) * 86_400_000);
  if (since > until) throw new Error(`--since ${since} is after --until ${until}`);

  console.log(`AppLovin advertiser report, ${since} to ${until} (UTC), into ${dir}`);
  const result = await sync({
    reporting: new AppLovinReporting({ apiKey: readKey() }),
    dir,
    since,
    until,
    log: (line) => console.log(line),
  });
  console.log(`${result.days} days, ${result.rows.toLocaleString("en-US")} rows.`);
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "--") argv = argv.slice(1);
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "-h" || command === "--help") return void console.log(USAGE);
  if (command === "pull") return pull(rest);
  throw new Error(`Unknown command ${command}\n\n${USAGE}`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
