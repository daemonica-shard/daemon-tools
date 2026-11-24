import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppLovinReporting } from "@daemon-tools/applovin";

// One CSV per UTC day: <dir>/<yyyy-mm-dd>.csv, exactly as AppLovin sends it, plus manifest.json
// saying when each day was last fetched. AppLovin keeps only 45 days and revises recent spend for a
// few days, so every run fetches the whole window again and overwrites it; days that have left the
// window keep the last copy, and that is how history builds up past 45 days.

/** Day first: rows are split into files by it. */
export const COLUMNS = [
  "day",
  "campaign",
  "campaign_id_external",
  "campaign_type",
  "bidding_and_billing_method",
  "country",
  "platform",
  "impressions",
  "clicks",
  "conversions",
  "cost",
] as const;

// A month comes back in seconds (36K rows, 5 MB), so two requests cover the window.
const CHUNK_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SyncOptions {
  reporting: Pick<AppLovinReporting, "report">;
  dir: string;
  /** First and last UTC day, both included. */
  since: string;
  until: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Manifest {
  [day: string]: { rows: number; fetchedAt: string };
}

/** Every day from since to until, both included, oldest first. */
export function days(since: string, until: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${since}T00:00:00Z`), end = Date.parse(`${until}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** CSV records, keeping a quoted line break inside its record. Empty lines are dropped. */
export function records(csv: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  const push = (end: number) => {
    const record = csv.slice(start, end).replace(/\r$/, "");
    if (record.length > 0) out.push(record);
  };
  for (let i = 0; i < csv.length; i++) {
    if (csv[i] === '"') quoted = !quoted;
    else if (csv[i] === "\n" && !quoted) {
      push(i);
      start = i + 1;
    }
  }
  push(csv.length);
  return out;
}

/** The header and the rows of each day, by the leading Day column. */
export function byDay(csv: string): { header: string; rows: Map<string, string[]> } {
  const [header, ...rest] = records(csv);
  if (!header || !/^day(,|$)/i.test(header)) {
    throw new Error(`Expected the report to start with a Day column, got: ${(header ?? "").slice(0, 80)}`);
  }
  const rows = new Map<string, string[]>();
  for (const row of rest) {
    const day = row.slice(0, 10);
    if (!DATE_RE.test(day) || (row.length > 10 && row[10] !== ",")) throw new Error(`Unexpected row: ${row.slice(0, 40)}`);
    const list = rows.get(day) ?? [];
    list.push(row);
    rows.set(day, list);
  }
  return { header, rows };
}

/** Fetches since..until and writes a file per day, including days with no rows. */
export async function sync(options: SyncOptions): Promise<{ days: number; rows: number }> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  await mkdir(options.dir, { recursive: true });
  const manifestPath = join(options.dir, "manifest.json");
  let manifest: Manifest = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  } catch {
    // first run
  }

  const all = days(options.since, options.until);
  let total = 0;
  for (let i = 0; i < all.length; i += CHUNK_DAYS) {
    const chunk = all.slice(i, i + CHUNK_DAYS);
    const fetchedAt = new Date(now()).toISOString();
    const csv = await options.reporting.report({
      reportType: "advertiser",
      start: chunk[0],
      end: chunk[chunk.length - 1],
      columns: COLUMNS,
    });
    const { header, rows } = byDay(csv);
    const stray = [...rows.keys()].filter((day) => !chunk.includes(day));
    if (stray.length > 0) throw new Error(`AppLovin returned rows for days outside ${chunk[0]}..${chunk.at(-1)}: ${stray.join(", ")}`);
    let chunkRows = 0;
    for (const day of chunk) {
      const dayRows = rows.get(day) ?? [];
      const path = join(options.dir, `${day}.csv`);
      await writeFile(`${path}.part`, `${[header, ...dayRows].join("\n")}\n`);
      await rename(`${path}.part`, path);
      manifest[day] = { rows: dayRows.length, fetchedAt };
      chunkRows += dayRows.length;
    }
    total += chunkRows;
    log(`${chunk[0]} to ${chunk.at(-1)}: ${chunkRows.toLocaleString("en-US")} rows.`);
  }
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(`${manifestPath}.part`, `${JSON.stringify(sorted, null, 2)}\n`);
  await rename(`${manifestPath}.part`, manifestPath);
  return { days: all.length, rows: total };
}
