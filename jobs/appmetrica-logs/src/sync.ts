import { setMaxListeners } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { AppMetricaClient, Application, ExportWait, LogsTable } from "@daemon-tools/appmetrica";
import { duckdbConverter, type Converter } from "./parquet.js";

// One Parquet file per table per day: <dir>/<table>/<yyyy-mm-dd>.parquet, plus a .json record of
// how it was fetched. Days are by arrival at AppMetrica (date_dimension=receive) in the app's time
// zone, not by device time. A row then lands in exactly one day, and once that day is over no new
// rows can join it, however late a device comes back online. Device time is still in every row.
//
// An export can cover several days at once (TableSpec.chunkDays) and is split into days by its
// arrival-time column. AppMetrica's preparing time barely depends on the range: 30 days of
// installs took 4 minutes, one day once took 11. Big tables stay at a day per export, since a
// month of impressions would be ~8 GB of CSV and the API's row limit isn't documented.
//
// AppMetrica doesn't document how long received rows take to become exportable, so a day only
// counts as final a full day after it ends. Until then, every run downloads it again.
export const FINAL_AFTER_MS = 24 * 60 * 60_000;

// The shortest max-age a request asks for. Polls run up to a minute apart, so a file finished
// between two polls must still count as fresh at the next one.
const MIN_MAX_AGE_S = 300;
const MAX_MAX_AGE_S = 24 * 60 * 60;

export interface TableSpec {
  table: LogsTable;
  fields: readonly string[];
  /** The arrival-time column, used to split an export into days. Must be among `fields`. */
  dayColumn: string;
  /** Days per export, at most. Default 1. */
  chunkDays?: number;
  /**
   * Only rows whose field equals the value, e.g. { event_name: "GameData" }. A filtered pull keeps its
   * own folder (see tableFolder), so it never passes for the whole table.
   */
  filters?: Readonly<Record<string, string>>;
}

/**
 * The table's folder under the app's: <table>, or <table>/<field>=<value>/… for a filtered pull, in
 * Hive's partition style. DuckDB reads either with a plain glob, and <table>/*.parquet never picks up
 * a filtered subset.
 */
export function tableFolder(spec: Pick<TableSpec, "table" | "filters">): string {
  const filters = Object.entries(spec.filters ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return join(spec.table, ...filters.map(([field, value]) => `${field}=${encodeURIComponent(value)}`));
}

/** The .json next to each day's Parquet file. */
export interface DayRecord {
  table: LogsTable;
  date: string;
  dateDimension: "receive";
  timeZone: string;
  fields: string[];
  /** Only for a filtered pull: the rows are those where each field equals its value. */
  filters?: Record<string, string>;
  rows: number;
  parquetBytes: number;
  /** The export the day came from: its days, rows and CSV size. */
  export: { since: string; until: string; rows: number; csvBytes: number };
  /** % of AppMetrica's shards that couldn't be read. */
  shardsUnavailable: number;
  fetchedAt: string;
  /** Requested a full day after the day ended, with every shard read: it won't change again. */
  final: boolean;
}

export interface SyncOptions {
  client: Pick<AppMetricaClient, "exportLogs">;
  app: Application;
  tables: TableSpec[];
  /** First and last day, yyyy-mm-dd, both included. */
  since: string;
  until: string;
  /** The app's folder. */
  dir: string;
  /** Download final days too. */
  refresh?: boolean;
  /** Exports in flight at once. AppMetrica queues at most 3 per app. */
  parallel?: number;
  /** CSV to Parquet. Default: an in-process DuckDB, closed when the sync ends. */
  converter?: Converter;
  now?: () => number;
  log?: (line: string) => void;
}

export interface TableSummary {
  table: LogsTable;
  /** Where its files went, under the app's folder: tableFolder. */
  folder: string;
  exports: number;
  downloaded: number;
  /** Downloaded days that will be downloaded again: not over long enough, or shards missing. */
  partial: number;
  /** Days already final on disk. */
  skipped: number;
  rows: number;
  csvBytes: number;
  parquetBytes: number;
}

/** Every day from since to until, both included, oldest first. */
export function days(since: string, until: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${since}T00:00:00Z`), end = Date.parse(`${until}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** The calendar day in the app's time zone at that instant. */
export function localDate(ms: number, offsetSeconds: number): string {
  return new Date(ms + offsetSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * When the day ends in the app's time zone, as a UTC instant. Uses the app's current UTC offset,
 * so it can be an hour off around a DST change, which the day-long margin before a day is final
 * absorbs.
 */
export function dayEnd(date: string, offsetSeconds: number): number {
  return Date.parse(`${date}T00:00:00Z`) + 86_400_000 - offsetSeconds * 1000;
}

/** Groups days (newest first) into runs of consecutive days, at most `size` long, oldest first within a run. */
export function chunks(daysNewestFirst: string[], size: number): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  for (const day of daysNewestFirst) {
    const previous = run[0];
    const adjacent = previous !== undefined && Date.parse(`${previous}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`) === 86_400_000;
    if (run.length > 0 && (!adjacent || run.length >= size)) {
      runs.push(run);
      run = [];
    }
    run.unshift(day);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

export async function sync(options: SyncOptions): Promise<TableSummary[]> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const converter = options.converter ?? duckdbConverter();
  // Newest first: the most recent days are the ones a question is most likely about.
  const dates = days(options.since, options.until).reverse();
  const summaries = new Map<TableSpec, TableSummary>();
  const tasks: Array<{ spec: TableSpec; days: string[] }> = [];

  try {
    for (const spec of options.tables) {
      const summary: TableSummary = {
        table: spec.table, folder: tableFolder(spec), exports: 0, downloaded: 0, partial: 0, skipped: 0, rows: 0, csvBytes: 0, parquetBytes: 0,
      };
      summaries.set(spec, summary);
      await mkdir(join(options.dir, tableFolder(spec)), { recursive: true });
      const missing: string[] = [];
      for (const date of dates) {
        if (!options.refresh && (await isFinal(options.dir, spec, date))) summary.skipped++;
        else missing.push(date);
      }
      for (const run of chunks(missing, spec.chunkDays ?? 1)) tasks.push({ spec, days: run });
    }

    await pool(tasks, options.parallel ?? 3, async ({ spec, days: run }, signal) => {
      const records = await fetchChunk(options, converter, spec, run, now, log, signal);
      const summary = summaries.get(spec)!;
      summary.exports++;
      summary.csvBytes += records[0].export.csvBytes;
      for (const record of records) {
        summary.downloaded++;
        summary.rows += record.rows;
        summary.parquetBytes += record.parquetBytes;
        if (!record.final) summary.partial++;
      }
    });
  } finally {
    if (!options.converter) converter.close();
  }
  return [...summaries.values()];
}

async function isFinal(dir: string, spec: TableSpec, date: string): Promise<boolean> {
  const base = join(dir, tableFolder(spec), date);
  try {
    const record = JSON.parse(await readFile(`${base}.json`, "utf8")) as DayRecord;
    await stat(`${base}.parquet`);
    // Columns changed since: fetch it again, so every file of a table has the same columns.
    return record.final === true && record.fields.join(",") === spec.fields.join(",");
  } catch {
    return false;
  }
}

async function fetchChunk(
  options: SyncOptions,
  converter: Converter,
  spec: TableSpec,
  run: string[],
  now: () => number,
  log: (line: string) => void,
  signal: AbortSignal,
): Promise<DayRecord[]> {
  const { app } = options;
  const first = run[0];
  const last = run[run.length - 1];
  const requestedAt = now();
  const settledAt = (day: string) => dayEnd(day, app.timeZoneOffset) + FINAL_AFTER_MS;
  const settled = (day: string) => requestedAt >= settledAt(day);
  // A cached file must be newer than the moment the export's last day settled, or it may hold that
  // day half filled in. While a day is still open, accept only a file from the last few minutes.
  const maxAgeSeconds = settled(last)
    ? Math.min(MAX_MAX_AGE_S, Math.max(MIN_MAX_AGE_S, Math.floor((requestedAt - settledAt(last)) / 1000)))
    : MIN_MAX_AGE_S;
  const label = first === last ? `${tableFolder(spec)} ${first}` : `${tableFolder(spec)} ${first} to ${last}`;
  let reported = 0;
  const onWait = (wait: ExportWait) => {
    if (wait.reason === "retrying") {
      log(`${label}: ${wait.detail}. Retrying in ${Math.round(wait.nextPollMs / 1000)} s.`);
    } else if (wait.waitedMs - reported >= 120_000) {
      // One line every two minutes per export, not one per poll.
      reported = wait.waitedMs;
      const what = wait.reason === "queue-full" ? "waiting for a free slot in AppMetrica's queue" : "still being prepared";
      log(`${label}: ${what} (${Math.round(wait.waitedMs / 60_000)} min).`);
    }
  };

  const file = await options.client.exportLogs(
    {
      applicationId: app.id,
      table: spec.table,
      since: `${first} 00:00:00`,
      until: `${last} 23:59:59`,
      fields: spec.fields,
      dateDimension: "receive",
      filters: spec.filters,
      maxAgeSeconds,
    },
    { signal, onWait },
  );

  // Download and split next to the final files, so a broken run never leaves a file that looks done.
  const folder = join(options.dir, tableFolder(spec));
  const csvPart = join(folder, `${last}.csv.part`);
  const parts = run.map((day) => ({ day, path: join(folder, `${day}.parquet.part`) }));
  let csvBytes: number;
  let counts: number[];
  try {
    csvBytes = await download(file.body, csvPart);
    counts = await converter.split(csvPart, spec.dayColumn, parts, spec.fields);
    const total = counts.reduce((a, b) => a + b, 0);
    if (file.rows !== null && total !== file.rows) {
      throw new Error(`${label}: AppMetrica reported ${file.rows} rows but the file holds ${total}. Nothing was saved.`);
    }
    for (const { day, path } of parts) await rename(path, join(folder, `${day}.parquet`));
  } finally {
    await rm(csvPart, { force: true });
    for (const { path } of parts) await rm(path, { force: true });
  }

  const total = counts.reduce((a, b) => a + b, 0);
  const records: DayRecord[] = [];
  for (const [i, day] of run.entries()) {
    const record: DayRecord = {
      table: spec.table,
      date: day,
      dateDimension: "receive",
      timeZone: app.timeZoneName,
      fields: [...spec.fields],
      ...(spec.filters && Object.keys(spec.filters).length > 0 ? { filters: { ...spec.filters } } : {}),
      rows: counts[i],
      parquetBytes: (await stat(join(folder, `${day}.parquet`))).size,
      export: { since: first, until: last, rows: total, csvBytes },
      shardsUnavailable: file.shardsUnavailable,
      fetchedAt: new Date(requestedAt).toISOString(),
      final: settled(day) && file.shardsUnavailable === 0,
    };
    await writeFile(join(folder, `${day}.json`), `${JSON.stringify(record, null, 2)}\n`);
    records.push(record);
  }

  const parquetBytes = records.reduce((a, r) => a + r.parquetBytes, 0);
  const finals = records.filter((r) => r.final).length;
  const status =
    finals === records.length
      ? "final"
      : file.shardsUnavailable > 0
        ? `partial: ${file.shardsUnavailable}% of AppMetrica's shards couldn't be read`
        : records.length === 1
          ? "partial: the day isn't settled yet"
          : `${finals} days final, ${records.length - finals} not settled yet`;
  log(`${label}: ${total.toLocaleString("en-US")} rows, ${formatBytes(parquetBytes)}, ${status}.`);
  return records;
}

/** Streams the file to disk and returns its size. */
async function download(body: ReadableStream<Uint8Array>, path: string): Promise<number> {
  let bytes = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), count, createWriteStream(path));
  return bytes;
}

/** Runs tasks `size` at a time. The first failure aborts the others and is rethrown. */
async function pool<T>(items: T[], size: number, run: (item: T, signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  // Every status check is a fetch on this one signal, and Node's fetch lets go of its listener only when the
  // request is garbage-collected: an hour of polling collects ~180 and warns of a leak that isn't one.
  setMaxListeners(0, controller.signal);
  let next = 0;
  let failed: { error: unknown } | undefined;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await run(item, controller.signal);
      } catch (error) {
        if (!failed) {
          failed = { error };
          controller.abort(error);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  if (failed) throw failed.error;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
