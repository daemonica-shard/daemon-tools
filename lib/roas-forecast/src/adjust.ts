// Adjust report export → one cohort curve (retention and ROAS by day) for the forecast.
//
// Each CSV row is one install day of one segment (app / channel / campaign …), with cohort
// metrics like retention_rate_d7 and roas_d7. The rows of one install day make up one cohort.
// Three things make the naive per-day average wrong:
//
// - Cells for days that haven't finished are partial. The export day itself is near zero and the
//   day before still runs low, so a cohort counts toward day N only when
//   installDate + N <= exportDate − 2.
// - Older days have fewer finished cohorts, and those can be a different mix (a weak launch week,
//   say). Averaged day by day, that mix bends the curve: ROAS can even appear to fall. So the curve
//   is chained: the first day is the average of every finished cohort, and each later day
//   multiplies the previous one by the growth seen in the cohorts that finished both days
//   (chain-ladder). Retention is weighted by installs; ROAS is revenue over spend.
// - Installs without spend (organic, untrusted devices, days a campaign reported no cost) have no
//   ROAS of their own, so a total read from roas_dN leaves their revenue out. When the export
//   carries cohort revenue by day, it counts as it is. Otherwise it is estimated from revenue by
//   event date: ROAS is raised by what those installs earned there, as a share of what paid
//   installs earned.

export interface ParsedCsv {
  columns: string[];
  records: Record<string, string>[];
}

export interface DayColumn {
  day: number;
  col: string;
}

export interface RevenueColumns {
  day: number;
  /** Summed per row: one all-revenue column, or ad revenue + in-app revenue. */
  cols: string[];
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
  /** roas_dN columns, or roas_ad_dN when that is all there is. Empty without a spend column. */
  roas: DayColumn[];
  /** "ad" when ROAS counts ad revenue only. */
  roasKind: "all" | "ad";
  /**
   * Cohort revenue by day N (cumulative from install day), when the export has it for every ROAS
   * day. ROAS is then read as revenue ÷ spend, which counts installs without spend too.
   */
  cohortRevenue: RevenueColumns[];
  /**
   * Revenue by event date: what a segment's players earned on that calendar day, whenever they
   * installed. Sizes the revenue of installs without spend when there is no cohort revenue.
   */
  eventRevenue: string[];
}

export interface Cohort {
  /** Install date as days since the Unix epoch (UTC). */
  date: number;
  installs: number;
  cost: number;
  dims: Record<string, string>;
  ret: Record<number, number>;
  roas: Record<number, number>;
  /** Cohort revenue by day N where it is known: from cohort revenue columns, or ROAS × spend. */
  revenue: Record<number, number>;
  /** Revenue by event date on this row's day; 0 when the export has no such column. */
  eventRevenue: number;
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
  /** Rows with spend ("paid"), rows without ("unpaid"), or both (the default). */
  spend?: "all" | "paid" | "unpaid";
}

export interface CurvePoint {
  day: number;
  value: number;
  /** Install days behind this point. */
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
  /** Spend ÷ all installs: the CPI to pair with ROAS that counts installs without spend. */
  blendedCpi: number | null;
  first: string | null;
  last: string | null;
}

export interface UnpaidInstalls {
  /** Installs in the selection that came without spend. */
  installs: number;
  /**
   * How their revenue reaches ROAS: "counted" from cohort revenue columns, "estimated" from
   * revenue by event date, "missing" when the export has neither. "none" when every row has spend.
   */
  revenue: "none" | "counted" | "estimated" | "missing";
  /** Revenue by event date over the selection, from rows without spend … */
  eventRevenue: number;
  /** … and from rows with it. */
  paidEventRevenue: number;
  /** What the estimate adds to ROAS, eventRevenue ÷ paidEventRevenue; 0 unless estimated. */
  uplift: number;
}

export interface CohortCurve {
  retention: CurvePoint[];
  roas: CurvePoint[];
  /** The first day left out for having too few finished cohorts; the chain stops there. */
  skipped: { retention: Skipped | null; roas: Skipped | null };
  summary: CohortSummary;
  unpaid: UnpaidInstalls;
}

export interface DimensionValue {
  value: string;
  cost: number;
  installs: number;
  /** Revenue by event date; 0 when the export has none. */
  eventRevenue: number;
}

/** A day needs this many finished cohorts (install days) … */
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

// Cohort revenue totals by day: all_revenue_total_dN, or ad_revenue_total_dN + revenue_total_dN
// (Adjust's revenue_total is in-app purchases only, so it never stands in for all revenue alone).
function cohortRevenueColumns(columns: string[], kind: "all" | "ad"): RevenueColumns[] {
  const byDay = (re: RegExp) => new Map(dayColumns(columns, re).map((c) => [c.day, c.col] as const));
  const all = byDay(/^all_revenue_total_d(\d+)$/);
  const ad = byDay(/^ad_revenue_total_d(\d+)$/);
  const iap = byDay(/^revenue_total_d(\d+)$/);
  const days = [...new Set([...all.keys(), ...ad.keys()])].sort((a, b) => a - b);
  const out: RevenueColumns[] = [];
  for (const day of days) {
    const a = all.get(day);
    const d = ad.get(day);
    const i = iap.get(day);
    if (kind === "ad") {
      if (d) out.push({ day, cols: [d] });
    } else if (a) out.push({ day, cols: [a] });
    else if (d && i) out.push({ day, cols: [d, i] });
  }
  return out;
}

// Revenue by event date of the same kind as ROAS. A partial stand-in (ad revenue for all revenue,
// say) would skew the estimate by however the two differ between paid and unpaid installs.
function eventRevenueColumns(has: (c: string) => boolean, kind: "all" | "ad"): string[] {
  const options = kind === "ad" ? [["ad_revenue"]] : [["all_revenue"], ["ad_revenue", "revenue"]];
  return options.find((cols) => cols.every(has)) ?? [];
}

export function detectSchema(columns: string[]): AdjustSchema {
  const has = (c: string) => columns.includes(c);
  const dateCol = ["day", "date", "install_date"].find(has);
  const installsCol = ["installs"].find(has);
  const costCol = ["cost", "network_cost", "ad_spend"].find(has);
  const retention = dayColumns(columns, /^retention_rate_d(\d+)$/);
  const roasAll = dayColumns(columns, /^roas_d(\d+)$/);
  const roasAd = dayColumns(columns, /^roas_ad_d(\d+)$/);
  const revenueAll = cohortRevenueColumns(columns, "all");
  const roasKind: "all" | "ad" = roasAll.length || (!roasAd.length && revenueAll.length) ? "all" : "ad";
  const roas = roasKind === "all" ? roasAll : roasAd;
  const revenue = roasKind === "all" ? revenueAll : cohortRevenueColumns(columns, "ad");
  // Cohort revenue replaces roas_dN only when it covers every ROAS day, so one curve never mixes
  // revenue that includes installs without spend with revenue that doesn't.
  const covers = revenue.length > 0 && roas.every((r) => revenue.some((x) => x.day === r.day));
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
    cohortRevenue: costCol && covers ? revenue : [],
    eventRevenue: eventRevenueColumns(has, roasKind),
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
      revenue: {},
      eventRevenue: schema.eventRevenue.reduce((s, col) => s + num(r[col]), 0),
    };
    for (const k of schema.dims) c.dims[k] = r[k] || "(none)";
    for (const x of schema.retention) c.ret[x.day] = num(r[x.col]);
    for (const x of schema.roas) c.roas[x.day] = num(r[x.col]);
    if (schema.cohortRevenue.length) {
      for (const x of schema.cohortRevenue) c.revenue[x.day] = x.cols.reduce((s, col) => s + num(r[col]), 0);
    } else if (c.cost > 0) {
      // Without cohort revenue, a row's revenue shows only through its ROAS, so only with spend.
      for (const x of schema.roas) c.revenue[x.day] = c.roas[x.day] * c.cost;
    }
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
    // Cohort cells run on past the last install date: an export of an older range (October,
    // exported mid-November) holds finished days well after it.
    completeThrough: exportDay - 2,
  };
}

function matches(c: Cohort, filter: CohortFilter, skipDim?: string): boolean {
  for (const [k, want] of Object.entries(filter.dims ?? {})) {
    if (k === skipDim) continue;
    if (want != null && want !== "" && c.dims[k] !== want) return false;
  }
  if (filter.from != null && c.date < filter.from) return false;
  if (filter.to != null && c.date > filter.to) return false;
  if (filter.spend === "paid" && !(c.cost > 0)) return false;
  if (filter.spend === "unpaid" && c.cost > 0) return false;
  return true;
}

/** The export's rows that match a filter. */
export function selectCohorts(data: AdjustExport, filter: CohortFilter = {}): Cohort[] {
  return data.cohorts.filter((c) => matches(c, filter));
}

/** Values of one segment column under the other filters, biggest spend first. */
export function dimensionValues(data: AdjustExport, dim: string, filter: CohortFilter = {}): DimensionValue[] {
  const seen = new Map<string, DimensionValue>();
  for (const c of data.cohorts) {
    if (!matches(c, filter, dim)) continue;
    const v = c.dims[dim];
    const entry = seen.get(v) ?? { value: v, cost: 0, installs: 0, eventRevenue: 0 };
    entry.cost += c.cost;
    entry.installs += c.installs;
    entry.eventRevenue += c.eventRevenue;
    seen.set(v, entry);
  }
  return [...seen.values()].sort((a, b) => b.cost - a.cost || b.installs - a.installs);
}

/**
 * One curve, chained across install days. `base` is what a value is per (installs, or spend) and
 * `amount` what a row holds on a day (retained installs, or revenue), undefined when unknown.
 */
function chain(
  days: number[],
  cohorts: Cohort[],
  completeThrough: number,
  base: (c: Cohort) => number,
  amount: (c: Cohort, day: number) => number | undefined,
): { points: CurvePoint[]; skipped: Skipped | null } {
  const points: CurvePoint[] = [];
  let skipped: Skipped | null = null;
  let prev: CurvePoint | null = null;
  const total = cohorts.reduce((s, c) => s + base(c), 0);
  for (const day of days) {
    const mature = cohorts.filter((c) => c.date + day <= completeThrough);
    const dates = new Set<number>();
    let w = 0;
    let installs = 0;
    for (const c of mature) {
      w += base(c);
      installs += c.installs;
      if (base(c) > 0) dates.add(c.date);
    }
    const share = total > 0 ? w / total : 0;
    if (dates.size < MIN_COHORTS || share < MIN_SHARE) {
      if (dates.size) skipped = { day, cohorts: dates.size, share };
      break;
    }
    // The first day is a level: what the finished rows hold over their base. Each later day is a
    // step: the growth across the rows known on both days.
    let now = 0;
    let before = 0;
    let known = 0;
    for (const c of mature) {
      const a = amount(c, day);
      const b = prev ? amount(c, prev.day) : 0;
      if (a === undefined || b === undefined) continue;
      now += a;
      before += b;
      known += base(c);
    }
    let v: number;
    if (!prev) {
      if (!(known > 0)) break;
      v = now / known;
    } else if (before > 0) v = prev.value * (now / before);
    else break;
    const point: CurvePoint = { day, value: v, cohorts: dates.size, installs, weight: w, share };
    points.push(point);
    prev = point;
  }
  return { points, skipped };
}

/** The selected cohorts as one retention curve and one ROAS curve, ready for `forecast`. */
export function aggregateCohorts(data: AdjustExport, filter: CohortFilter = {}): CohortCurve {
  const sel = selectCohorts(data, filter);
  let installs = 0;
  let cost = 0;
  let paidInstalls = 0;
  let unpaidRows = 0;
  let eventRevenue = 0;
  let paidEventRevenue = 0;
  const dates = new Set<number>();
  for (const c of sel) {
    installs += c.installs;
    cost += c.cost;
    eventRevenue += c.eventRevenue;
    dates.add(c.date);
    if (c.cost > 0) {
      paidInstalls += c.installs;
      paidEventRevenue += c.eventRevenue;
    } else unpaidRows++;
  }
  const { schema, completeThrough: ct } = data;
  const retention = chain(
    schema.retention.map((x) => x.day),
    sel,
    ct,
    (c) => c.installs,
    (c, d) => c.installs * (c.ret[d] ?? 0),
  );
  const roas = chain(
    (schema.cohortRevenue.length ? schema.cohortRevenue : schema.roas).map((x) => x.day),
    sel,
    ct,
    (c) => c.cost,
    (c, d) => c.revenue[d],
  );

  const unpaid: UnpaidInstalls = {
    installs: installs - paidInstalls,
    revenue: "none",
    eventRevenue: eventRevenue - paidEventRevenue,
    paidEventRevenue,
    uplift: 0,
  };
  if (unpaidRows > 0) {
    if (schema.cohortRevenue.length) unpaid.revenue = "counted";
    else if (schema.eventRevenue.length && paidEventRevenue > 0) {
      // Assumes their revenue builds up with player age the way paid revenue does, so the share
      // they add by event date holds on every cohort day.
      unpaid.revenue = "estimated";
      unpaid.uplift = unpaid.eventRevenue / paidEventRevenue;
    } else unpaid.revenue = "missing";
  }
  const roasPoints = unpaid.uplift > 0 ? roas.points.map((p) => ({ ...p, value: p.value * (1 + unpaid.uplift) })) : roas.points;

  const ds = [...dates].sort((a, b) => a - b);
  return {
    retention: retention.points,
    roas: roasPoints,
    skipped: { retention: retention.skipped, roas: roas.skipped },
    summary: {
      rows: sel.length,
      cohortDays: ds.length,
      installs,
      unpaidInstalls: installs - paidInstalls,
      cost,
      cpi: paidInstalls > 0 && cost > 0 ? cost / paidInstalls : null,
      blendedCpi: installs > 0 && cost > 0 ? cost / installs : null,
      first: ds.length ? fromDay(ds[0]) : null,
      last: ds.length ? fromDay(ds[ds.length - 1]) : null,
    },
    unpaid,
  };
}
