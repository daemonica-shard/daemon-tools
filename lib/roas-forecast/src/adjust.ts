// Adjust report export → one cohort curve (retention and ROAS by day) for the forecast.
//
// Each CSV row is one install day of one segment (app / channel / campaign …), with cohort
// metrics like retention_rate_d7 and roas_d7. Two things make the naive per-day average wrong:
//
// - Cells for days that haven't finished are partial. The export day itself is near zero and the
//   day before still runs low, so a cohort counts toward day N only when
//   installDate + N <= exportDate − 2.
// - Older days have fewer finished cohorts, and those can be a different mix (a weak launch week,
//   say). Averaged day by day, that mix bends the curve: ROAS can even appear to fall. So the curve
//   is chained: the first day is the weighted average of every finished cohort, and each later day
//   multiplies the previous one by the growth seen in the cohorts that finished both days
//   (chain-ladder). Retention is weighted by installs, ROAS by spend.

export interface ParsedCsv {
  columns: string[];
  records: Record<string, string>[];
}

export interface DayColumn {
  day: number;
  col: string;
}

export interface AdjustSchema {
  ok: boolean;
  missing: string[];
  dateCol?: string;
  installsCol?: string;
  costCol?: string;
  /** Segment columns present in the export (app, channel, campaign, country …). */
  dims: string[];
  retention: DayColumn[];
  roas: DayColumn[];
  /** "ad" when only roas_ad_dN columns exist. */
  roasKind: "all" | "ad";
}

export interface Cohort {
  /** Install date as days since the Unix epoch (UTC). */
  date: number;
  installs: number;
  cost: number;
  dims: Record<string, string>;
  ret: Record<number, number>;
  roas: Record<number, number>;
}

export interface AdjustExport {
  ok: true;
  fileName: string;
  schema: AdjustSchema;
  cohorts: Cohort[];
  minDate: number;
  maxDate: number;
  /** YYYY-MM-DD, from the file name when it has one. */
  exportDate: string;
  exportDateGuessed: boolean;
  /** Last calendar day (days since epoch) whose cohort cells count as finished. */
  completeThrough: number;
}

export interface AdjustLoadError {
  ok: false;
  schema: AdjustSchema;
  empty?: boolean;
}

export interface CohortFilter {
  dims?: Record<string, string>;
  /** Install dates, days since epoch, inclusive. */
  from?: number | null;
  to?: number | null;
}

export interface CurvePoint {
  day: number;
  value: number;
  cohorts: number;
  installs: number;
  weight: number;
  /** Share of the selection's installs (retention) or spend (ROAS) behind this point. */
  share: number;
}

export interface Skipped {
  day: number;
  cohorts: number;
  share: number;
}

export interface CohortSummary {
  rows: number;
  cohortDays: number;
  installs: number;
  unpaidInstalls: number;
  cost: number;
  /** Spend ÷ paid installs. */
  cpi: number | null;
  first: string | null;
  last: string | null;
}

export interface CohortCurve {
  retention: CurvePoint[];
  roas: CurvePoint[];
  /** The first day left out for having too few finished cohorts; the chain stops there. */
  skipped: { retention: Skipped | null; roas: Skipped | null };
  summary: CohortSummary;
}

export interface DimensionValue {
  value: string;
  cost: number;
  installs: number;
}

/** A day needs this many finished cohorts … */
export const MIN_COHORTS = 3;
/** … carrying this share of the selection's installs (retention) or spend (ROAS). */
export const MIN_SHARE = 0.1;

const DAY_MS = 86_400_000;

const KNOWN_DIMS = [
  "app",
  "os_name",
  "channel",
  "network",
  "partner_name",
  "campaign_network",
  "campaign",
  "adgroup_network",
  "adgroup",
  "creative_network",
  "creative",
  "country",
  "country_code",
  "store_type",
];

export function parseCsv(text: string): ParsedCsv {
  const src = String(text ?? "").replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
  if (!nonEmpty.length) return { columns: [], records: [] };
  const columns = nonEmpty[0].map((h) => h.trim());
  const records = nonEmpty.slice(1).map((r) => {
    const o: Record<string, string> = {};
    columns.forEach((h, j) => {
      o[h] = (r[j] ?? "").trim();
    });
    return o;
  });
  return { columns, records };
}

function dayColumns(columns: string[], re: RegExp): DayColumn[] {
  const out: DayColumn[] = [];
  for (const col of columns) {
    const m = re.exec(col);
    if (m) out.push({ day: Number(m[1]), col });
  }
  return out.sort((a, b) => a.day - b.day);
}

export function detectSchema(columns: string[]): AdjustSchema {
  const has = (c: string) => columns.includes(c);
  const dateCol = ["day", "date", "install_date"].find(has);
  const installsCol = ["installs"].find(has);
  const costCol = ["cost", "network_cost", "ad_spend"].find(has);
  const retention = dayColumns(columns, /^retention_rate_d(\d+)$/);
  let roas = dayColumns(columns, /^roas_d(\d+)$/);
  let roasKind: "all" | "ad" = "all";
  if (!roas.length) {
    roas = dayColumns(columns, /^roas_ad_d(\d+)$/);
    roasKind = "ad";
  }
  const missing: string[] = [];
  if (!dateCol) missing.push("day");
  if (!installsCol) missing.push("installs");
  if (!retention.length) missing.push("retention_rate_dN");
  return {
    ok: missing.length === 0,
    missing,
    dateCol,
    installsCol,
    costCol,
    dims: KNOWN_DIMS.filter(has),
    retention,
    // ROAS is only meaningful against spend.
    roas: costCol ? roas : [],
    roasKind,
  };
}

/** YYYY-MM-DD → days since the Unix epoch (UTC). */
export function toDay(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS : null;
}

/** Days since the Unix epoch → YYYY-MM-DD. */
export function fromDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** "2026-03-31_10_0_adjust_report_export.csv" → "2026-03-31". */
export function exportDateFromName(name?: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(name ?? "");
  return m ? m[1] : null;
}

function num(s: string | undefined): number {
  const v = parseFloat(s ?? "");
  return Number.isFinite(v) ? v : 0;
}

/**
 * Reads an Adjust report export. The export date comes from the file name when it carries one
 * (Adjust names downloads with it); otherwise the day after the latest install date is assumed.
 */
export function loadAdjustExport(text: string, fileName?: string): AdjustExport | AdjustLoadError {
  const parsed = parseCsv(text);
  const schema = detectSchema(parsed.columns);
  if (!schema.ok) return { ok: false, schema };
  const cohorts: Cohort[] = [];
  for (const r of parsed.records) {
    const date = toDay(r[schema.dateCol!]);
    if (date == null) continue;
    const c: Cohort = {
      date,
      installs: num(r[schema.installsCol!]),
      cost: schema.costCol ? num(r[schema.costCol]) : 0,
      dims: {},
      ret: {},
      roas: {},
    };
    for (const k of schema.dims) c.dims[k] = r[k] || "(none)";
    for (const x of schema.retention) c.ret[x.day] = num(r[x.col]);
    for (const x of schema.roas) c.roas[x.day] = num(r[x.col]);
    cohorts.push(c);
  }
  if (!cohorts.length) return { ok: false, schema, empty: true };
  let minDate = Infinity;
  let maxDate = -Infinity;
  for (const c of cohorts) {
    if (c.date < minDate) minDate = c.date;
    if (c.date > maxDate) maxDate = c.date;
  }
  const exported = exportDateFromName(fileName);
  const exportDay = exported ? toDay(exported)! : maxDate + 1;
  return {
    ok: true,
    fileName: fileName || "export.csv",
    schema,
    cohorts,
    minDate,
    maxDate,
    exportDate: fromDay(exportDay),
    exportDateGuessed: !exported,
    completeThrough: Math.min(exportDay - 2, maxDate),
  };
}

function matches(c: Cohort, filter: CohortFilter, skipDim?: string): boolean {
  for (const [k, want] of Object.entries(filter.dims ?? {})) {
    if (k === skipDim) continue;
    if (want != null && want !== "" && c.dims[k] !== want) return false;
  }
  if (filter.from != null && c.date < filter.from) return false;
  if (filter.to != null && c.date > filter.to) return false;
  return true;
}

/** Values of one segment column under the other filters, biggest spend first. */
export function dimensionValues(data: AdjustExport, dim: string, filter: CohortFilter = {}): DimensionValue[] {
  const seen = new Map<string, DimensionValue>();
  for (const c of data.cohorts) {
    if (!matches(c, filter, dim)) continue;
    const v = c.dims[dim];
    const entry = seen.get(v) ?? { value: v, cost: 0, installs: 0 };
    entry.cost += c.cost;
    entry.installs += c.installs;
    seen.set(v, entry);
  }
  return [...seen.values()].sort((a, b) => b.cost - a.cost || b.installs - a.installs);
}

function chain(
  days: number[],
  cohorts: Cohort[],
  completeThrough: number,
  weight: (c: Cohort) => number,
  value: (c: Cohort, day: number) => number,
): { points: CurvePoint[]; skipped: Skipped | null } {
  const points: CurvePoint[] = [];
  let skipped: Skipped | null = null;
  let prev: CurvePoint | null = null;
  const total = cohorts.reduce((s, c) => s + weight(c), 0);
  for (const day of days) {
    const mature = cohorts.filter((c) => c.date + day <= completeThrough && weight(c) > 0);
    let w = 0;
    let now = 0;
    let before = 0;
    let installs = 0;
    for (const c of mature) {
      w += weight(c);
      now += weight(c) * value(c, day);
      if (prev) before += weight(c) * value(c, prev.day);
      installs += c.installs;
    }
    const share = total > 0 ? w / total : 0;
    if (mature.length < MIN_COHORTS || share < MIN_SHARE) {
      if (mature.length) skipped = { day, cohorts: mature.length, share };
      break;
    }
    let v: number;
    if (!prev) v = now / w;
    else if (before > 0) v = prev.value * (now / before);
    else break;
    const point: CurvePoint = { day, value: v, cohorts: mature.length, installs, weight: w, share };
    points.push(point);
    prev = point;
  }
  return { points, skipped };
}

/** The selected cohorts as one retention curve and one ROAS curve, ready for `forecast`. */
export function aggregateCohorts(data: AdjustExport, filter: CohortFilter = {}): CohortCurve {
  const sel = data.cohorts.filter((c) => matches(c, filter));
  let installs = 0;
  let cost = 0;
  let paidInstalls = 0;
  const dates = new Set<number>();
  for (const c of sel) {
    installs += c.installs;
    cost += c.cost;
    dates.add(c.date);
    if (c.cost > 0) paidInstalls += c.installs;
  }
  const ct = data.completeThrough;
  const retention = chain(
    data.schema.retention.map((x) => x.day),
    sel,
    ct,
    (c) => c.installs,
    (c, d) => c.ret[d] ?? 0,
  );
  const roas = chain(
    data.schema.roas.map((x) => x.day),
    sel,
    ct,
    (c) => c.cost,
    (c, d) => c.roas[d] ?? 0,
  );
  const ds = [...dates].sort((a, b) => a - b);
  return {
    retention: retention.points,
    roas: roas.points,
    skipped: { retention: retention.skipped, roas: roas.skipped },
    summary: {
      rows: sel.length,
      cohortDays: ds.length,
      installs,
      unpaidInstalls: installs - paidInstalls,
      cost,
      cpi: paidInstalls > 0 && cost > 0 ? cost / paidInstalls : null,
      first: ds.length ? fromDay(ds[0]) : null,
      last: ds.length ? fromDay(ds[ds.length - 1]) : null,
    },
  };
}
