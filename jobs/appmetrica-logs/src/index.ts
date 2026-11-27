#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppMetricaClient, DEFAULT_FIELDS, LOGS_TABLES, RECEIVE_DATETIME, type LogsTable } from "@daemon-tools/appmetrica";
import { assertOutsideRepo, findApp, formatOffset, readToken } from "./config.js";
import { formatBytes, localDate, sync, tableFolder, type TableSpec } from "./sync.js";

// Custom events (the events table) are left out by default: over a million rows a day, and the
// standard tables cover revenue, installs and activity.
const DEFAULT_TABLES: LogsTable[] = ["ad_revenue_events", "installations", "sessions_starts", "revenue_events"];
const DEFAULT_DAYS = 30;
// Days per export. Small tables go a month at a time, since AppMetrica takes about as long to
// prepare a month as a day. Big ones stay at a day: a day of impressions is already ~270 MB of CSV.
const CHUNK_DAYS: Partial<Record<LogsTable, number>> = { installations: 31, sessions_starts: 31, revenue_events: 31 };

function spec(table: LogsTable, chunkDays?: number, fields?: string[], filters?: Record<string, string>): TableSpec {
  return {
    table,
    fields: fields ?? DEFAULT_FIELDS[table]!,
    dayColumn: RECEIVE_DATETIME[table]!,
    chunkDays: chunkDays ?? CHUNK_DAYS[table] ?? 1,
    ...(filters ? { filters } : {}),
  };
}

const USAGE = `appmetrica-logs: download AppMetrica's raw logs (ad impressions, events, sessions, installs) as Parquet

  appmetrica-logs apps                          apps this token can read: id, name, time zone
  appmetrica-logs pull --app APP --out DIR      one Parquet file per table per day
  appmetrica-logs queries --app APP [--cancel]  exports AppMetrica is still preparing for the app

Options for pull:
  --app ID|NAME   the app's numeric id, or a part of its name that matches one app only
  --out DIR       a folder outside this repo (the repo is public). Files go to
                  DIR/<app id>/<table>/<yyyy-mm-dd>.parquet
  --since DATE    first day, yyyy-mm-dd (default: the ${DEFAULT_DAYS} days up to --until)
  --until DATE    last day (default: today in the app's time zone)
  --tables LIST   comma-separated (default: ${DEFAULT_TABLES.join(",")})
  --refresh       download final days again too
  --parallel N    exports in flight at once, 1 to 3 (default 3, AppMetrica's limit per app)
  --chunk-days N  days per export, for every table pulled (default: 1 for impressions and events,
                  31 for the small tables). For a big app, AppMetrica takes about as long to prepare
                  several days as one, so more days per export can cut the wait many times over.
  --fields LIST   comma-separated columns instead of the defaults, for one table (--tables with a
                  single name). Must include the table's arrival time column, which splits days.
                  Fewer columns make smaller files; days pulled with other columns are pulled again.
  --filter F=V    only rows whose column F equals V, for one table (--tables with a single name);
                  repeat for more. E.g. --tables events --filter event_name=GameData. Files go to
                  DIR/<app id>/<table>/F=V/<yyyy-mm-dd>.parquet, apart from the whole table's.

Days are by arrival at AppMetrica, in the app's time zone. A day becomes final a full day after it
ends; until then every run downloads it again. Final days are skipped, so a re-run fetches only
what's new.

Environment:
  APPMETRICA_TOKEN       OAuth token with appmetrica:read, or
  APPMETRICA_TOKEN_FILE  a file holding it (default ~/.config/appmetrica/token)
`;

// How AppMetrica numbers its tables in the list of active exports.
const ENTITIES: Record<number, string> = {
  0: "clicks", 1: "installations", 2: "events", 3: "postbacks", 4: "errors", 5: "crashes", 6: "push_tokens",
  7: "sessions_starts", 9: "deeplinks", 10: "revenue_events", 12: "profiles", 13: "ad_revenue_events", 14: "ecommerce_events",
};

// dist/index.js or src/index.ts, three levels below the repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface PullArgs {
  app: string;
  out: string;
  since?: string;
  until?: string;
  tables: LogsTable[];
  refresh: boolean;
  parallel: number;
  chunkDays?: number;
  fields?: string[];
  filters?: Record<string, string>;
}

function options(argv: string[], handle: (arg: string, next: () => string) => boolean): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (!handle(arg, next)) throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
  }
}

function date(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name} must be a date like 2026-11-20`);
  }
  return value;
}

function tables(value: string): LogsTable[] {
  return value.split(",").map((raw) => {
    const name = raw.trim() as LogsTable;
    if (!LOGS_TABLES.includes(name)) throw new Error(`Unknown table ${raw}. Logs API tables: ${LOGS_TABLES.join(", ")}`);
    if (!DEFAULT_FIELDS[name] || !RECEIVE_DATETIME[name]) {
      throw new Error(`No columns chosen for ${name} yet: add them to lib/appmetrica/src/fields.ts`);
    }
    return name;
  });
}

function parsePull(argv: string[]): PullArgs {
  const args: Partial<PullArgs> = { tables: DEFAULT_TABLES, refresh: false, parallel: 3 };
  options(argv, (arg, next) => {
    if (arg === "--app") args.app = next();
    else if (arg === "--out") args.out = next();
    else if (arg === "--since") args.since = date(next(), arg);
    else if (arg === "--until") args.until = date(next(), arg);
    else if (arg === "--tables") args.tables = tables(next());
    else if (arg === "--refresh") args.refresh = true;
    else if (arg === "--parallel") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1 || n > 3) throw new Error("--parallel must be 1, 2 or 3");
      args.parallel = n;
    } else if (arg === "--chunk-days") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error("--chunk-days must be a whole number from 1 to 31");
      args.chunkDays = n;
    } else if (arg === "--fields") {
      args.fields = next().split(",").map((f) => f.trim()).filter(Boolean);
    } else if (arg === "--filter") {
      const value = next();
      const eq = value.indexOf("=");
      const field = value.slice(0, eq);
      if (eq < 1 || !/^[a-z0-9_]+$/.test(field) || eq === value.length - 1) {
        throw new Error(`--filter takes column=value, e.g. event_name=GameData: got ${value}`);
      }
      args.filters = { ...args.filters, [field]: value.slice(eq + 1) };
    } else return false;
    return true;
  });
  if (!args.app) throw new Error('pull needs --app: an id or name from "appmetrica-logs apps"');
  if (!args.out) throw new Error("pull needs --out: a folder outside this repo");
  if (args.filters && args.tables!.length !== 1) throw new Error("--filter applies to one table: pass --tables with a single name");
  if (args.fields) {
    if (args.tables!.length !== 1) throw new Error("--fields applies to one table: pass --tables with a single name");
    const bad = args.fields.filter((f) => !/^[a-z0-9_]+$/.test(f));
    if (bad.length > 0) throw new Error(`Not a column name: ${bad.join(", ")}`);
    const dayColumn = RECEIVE_DATETIME[args.tables![0]]!;
    if (!args.fields.includes(dayColumn)) throw new Error(`--fields must include ${dayColumn}, which splits the export into days`);
  }
  return args as PullArgs;
}

function shiftDate(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows.map((r) => r.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd()).join("\n");
}

async function apps(): Promise<void> {
  const client = new AppMetricaClient({ token: readToken() });
  const [list, status] = await Promise.all([
    client.listApplications(),
    client.logsApiStatus().catch((err: Error) => `unknown (${err.message})`),
  ]);
  console.log(`Logs API: ${status}\n`);
  if (list.length === 0) {
    console.log("This token can't read any app. Get a token while signed in to a Yandex account that can open the app in AppMetrica.");
    return;
  }
  const rows = list.map((a) => [String(a.id), a.name, `${a.timeZoneName} (${formatOffset(a.timeZoneOffset)})`, a.permission]);
  console.log(table([["id", "name", "time zone", "access"], ...rows]));
}

async function pull(args: PullArgs): Promise<void> {
  // pnpm runs scripts from the package folder; INIT_CWD is where the command was typed.
  const out = resolve(process.env.INIT_CWD ?? process.cwd(), args.out);
  assertOutsideRepo(out, REPO_ROOT);
  const client = new AppMetricaClient({ token: readToken() });
  const app = findApp(await client.listApplications(), args.app);
  const until = args.until ?? localDate(Date.now(), app.timeZoneOffset);
  const since = args.since ?? shiftDate(until, -(DEFAULT_DAYS - 1));
  if (since > until) throw new Error(`--since ${since} is after --until ${until}`);

  const dir = join(out, String(app.id));
  await mkdir(dir, { recursive: true });
  const about = {
    id: app.id,
    name: app.name,
    timeZoneName: app.timeZoneName,
    timeZoneOffset: app.timeZoneOffset,
    days: "Each <table>/<yyyy-mm-dd>.parquet holds the rows AppMetrica received that day, in the app's time zone (date_dimension=receive). Every column is text, as AppMetrica sent it.",
  };
  await writeFile(join(dir, "app.json"), `${JSON.stringify(about, null, 2)}\n`);
  console.log(`${app.name} (${app.id}): ${since} to ${until}, days in ${app.timeZoneName} (${formatOffset(app.timeZoneOffset)}), into ${dir}`);

  const started = Date.now();
  const summaries = await sync({
    client,
    app,
    tables: args.tables.map((t) => spec(t, args.chunkDays, args.fields, args.filters)),
    since,
    until,
    dir,
    refresh: args.refresh,
    parallel: args.parallel,
    log: (line) => console.log(line),
  });
  console.log("");
  for (const s of summaries) {
    const partial = s.partial > 0 ? ` (${s.partial} partial, fetched again next run)` : "";
    console.log(
      `${s.folder}: ${s.downloaded} days downloaded in ${s.exports} exports${partial}, ${s.rows.toLocaleString("en-US")} rows, ` +
        `${formatBytes(s.parquetBytes)} kept (${formatBytes(s.csvBytes)} as CSV). ${s.skipped} days were already final.`,
    );
  }
  console.log(`Took ${Math.round((Date.now() - started) / 1000)} s.`);
}

async function queries(argv: string[]): Promise<void> {
  let wanted: string | undefined;
  let cancel = false;
  options(argv, (arg, next) => {
    if (arg === "--app") wanted = next();
    else if (arg === "--cancel") cancel = true;
    else return false;
    return true;
  });
  if (!wanted) throw new Error("queries needs --app");
  const client = new AppMetricaClient({ token: readToken() });
  const app = findApp(await client.listApplications(), wanted);
  const active = await client.activeQueries(app.id);
  if (active.length === 0) {
    console.log(`No exports queued for ${app.name}.`);
    return;
  }
  for (const q of active) {
    const what = ENTITIES[q.entity] ?? `entity ${q.entity}`;
    console.log(
      `${q.requestId}  ${what}  ${q.status === 1 ? "processed" : "created"}  ${Math.round(q.progress * 100)}%  ` +
        `${q.rowsLoaded.toLocaleString("en-US")} rows  since ${q.createTime}`,
    );
    console.log(`  ${q.query}`);
    if (cancel) console.log(`  ${await client.cancelQuery(app.id, q.requestId)}`);
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "--") argv = argv.slice(1);
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      return;
    case "apps":
      return apps();
    case "pull":
      return pull(parsePull(rest));
    case "queries":
      return queries(rest);
    default:
      throw new Error(`Unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
