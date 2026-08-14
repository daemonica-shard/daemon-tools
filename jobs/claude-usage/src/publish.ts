import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { Archive } from "./archive.js";

// Publishes finished days from the archive into Prometheus, so the Grafana panels keep moving
// without the manual promtool block import (backfill/README.md) that seeded them.
//
// The same OTLP endpoint Claude Code itself pushes to — already token-gated by Caddy — is reused
// rather than opening a second write path. Prometheus' remote-write receiver would need its own
// route, its own flag, and protobuf+snappy framing; OTLP JSON is a plain fetch.
//
// Emitted as gauges under the archive's own metric names, matching the promtool import exactly:
// the series must be continuous across the two eras, or every panel gets a seam on the day this
// job took over.

const TOKEN_TYPES = {
  inputTokens: "input",
  outputTokens: "output",
  cacheCreationTokens: "cacheCreation",
  cacheReadTokens: "cacheRead",
} as const;

const TOKENS_METRIC = "claude_usage_archive_daily_tokens";
const COST_METRIC = "claude_usage_archive_daily_cost_USD";

export interface PublishState {
  updatedAt: string;
  // Days this job has dealt with — sent, seeded past on a first run, or reported as aged out.
  // "Handled" rather than "published" so a day that fell out of the window is named once and then
  // stops being news; a set of only-the-sent days would re-report every permanent gap forever.
  handled: string[];
}

export const NO_STATE: PublishState = { updatedAt: "", handled: [] };

export interface SelectOptions {
  today: string; // YYYY-MM-DD
  windowDays: number; // must match Prometheus' out_of_order_time_window
  since?: string; // floor for a manual catch-up; defaults to yesterday on a first run
  firstRun: boolean;
}

export interface Selection {
  publish: string[];
  tooOld: string[];
  seed: string[];
}

// ccusage keys days by *local* date, so "today" has to be local too. A UTC date is wrong by a whole
// day for anyone east of Greenwich: this job runs at 03:10 local, which is still the previous day in
// UTC, so every finished day would look unfinished and wait an extra cycle.
//
// Only the comparison is local. Samples stay stamped at UTC midnight below, matching the days the
// promtool import already wrote — switching to local midnight now would put a timezone-wide seam in
// the middle of the series.
export function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shift(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`unparseable date: ${date}`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

// Which days to send, which are beyond saving, and which to quietly write off.
//
// Only days strictly before today: today's total is still growing, and a day may be published
// exactly once — the dashboard's stat panels sum_over_time() every sample in range, so a second
// sample for a day it already holds would silently inflate the totals.
//
// A first run writes off everything before yesterday instead of sending it. Those days are already
// in Prometheus from the promtool import, at these very timestamps, and re-sending one whose value
// drifted by a rounding step is a duplicate-sample error that fails the whole batch. A deliberate
// catch-up says so with --publish-since.
export function select(archive: Archive, handled: Set<string>, opts: SelectOptions): Selection {
  const oldest = shift(opts.today, -opts.windowDays);
  const floor = opts.since ?? (opts.firstRun ? shift(opts.today, -1) : undefined);

  const candidates = Object.keys(archive.days)
    .filter((d) => d < opts.today && !handled.has(d))
    .sort();

  // Below the floor is a deliberate write-off, not a gap: seeded past on a first run, or days the
  // operator excluded from a catch-up. Silent by design — unlike tooOld, which is a real loss.
  const seed = floor ? candidates.filter((d) => d < floor) : [];
  const rest = floor ? candidates.filter((d) => d >= floor) : candidates;

  return {
    // Prometheus rejects anything older than the out-of-order window, and one bad point fails the
    // whole batch — so these are named and written off rather than sent to fail.
    publish: rest.filter((d) => d >= oldest),
    tooOld: rest.filter((d) => d < oldest),
    seed,
  };
}

interface Attribute {
  key: string;
  value: { stringValue: string };
}

interface DataPoint {
  timeUnixNano: string;
  asDouble: number;
  attributes: Attribute[];
}

function attrs(pairs: Record<string, string>): Attribute[] {
  return Object.entries(pairs).map(([key, value]) => ({ key, value: { stringValue: value } }));
}

// OTLP JSON. uint64 fields are strings in the proto3 JSON mapping — a nanosecond timestamp is well
// past the point where a JSON number stays exact.
export function payload(archive: Archive, days: string[], instance: string): unknown {
  const tokens: DataPoint[] = [];
  const cost: DataPoint[] = [];

  for (const date of days) {
    const day = archive.days[date];
    if (!day) continue;
    const ts = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(ts)) throw new Error(`unparseable date key: ${date}`);
    const timeUnixNano = `${ts}000000`;

    // Per-model only. An unlabelled total alongside these would double-count under sum().
    const breakdowns = (day.modelBreakdowns ?? []) as Record<string, unknown>[];
    for (const m of breakdowns) {
      const model = String(m.modelName ?? "unknown");
      for (const [field, type] of Object.entries(TOKEN_TYPES)) {
        const v = m[field];
        if (typeof v === "number" && v > 0) {
          tokens.push({ timeUnixNano, asDouble: v, attributes: attrs({ model, type }) });
        }
      }
      if (typeof m.cost === "number" && m.cost > 0) {
        cost.push({ timeUnixNano, asDouble: m.cost, attributes: attrs({ model }) });
      }
    }
  }

  const metrics = [];
  if (tokens.length) {
    metrics.push({
      name: TOKENS_METRIC,
      description: "Daily tokens recovered from Claude Code transcripts before pruning",
      gauge: { dataPoints: tokens },
    });
  }
  if (cost.length) {
    metrics.push({
      name: COST_METRIC,
      description: "Daily equivalent API cost recovered from the same archive",
      gauge: { dataPoints: cost },
    });
  }

  return {
    resourceMetrics: [
      {
        // service.name/instance become the job/instance labels. Instance is the hostname because
        // the archive is per-machine: a second Mac must land on its own series, not overwrite this
        // one's samples at the same timestamps.
        resource: {
          attributes: attrs({ "service.name": "claude-usage", "service.instance.id": instance }),
        },
        scopeMetrics: [{ scope: { name: "claude-usage" }, metrics }],
      },
    ],
  };
}

export interface Endpoint {
  url: string; // OTLP base, e.g. https://otel.example.com/api/v1/otlp
  token: string;
}

export function endpointFromEnv(env: NodeJS.ProcessEnv = process.env): Endpoint | undefined {
  const url = env.CLAUDE_USAGE_OTLP_ENDPOINT;
  const token = env.CLAUDE_USAGE_OTLP_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : undefined;
}

export async function send(endpoint: Endpoint, body: unknown): Promise<void> {
  const res = await fetch(`${endpoint.url}/v1/metrics`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`OTLP ingest returned ${res.status}: ${text.slice(0, 300)}`);

  // A 200 can still mean nothing was stored: OTLP reports per-point rejections in the body, and
  // an out-of-order or duplicate sample lands here rather than in the status code.
  let rejected = 0;
  let message = "";
  try {
    const parsed = JSON.parse(text || "{}") as {
      partialSuccess?: { rejectedDataPoints?: string | number; errorMessage?: string };
    };
    rejected = Number(parsed.partialSuccess?.rejectedDataPoints ?? 0);
    message = parsed.partialSuccess?.errorMessage ?? "";
  } catch {
    return; // empty or non-JSON body is the ordinary success case
  }
  if (rejected > 0) throw new Error(`OTLP ingest rejected ${rejected} points: ${message}`);
}

export async function loadState(path: string): Promise<PublishState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return NO_STATE;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<PublishState>;
  return { updatedAt: parsed.updatedAt ?? "", handled: parsed.handled ?? [] };
}

export async function saveState(path: string, state: PublishState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export interface PublishOptions {
  statePath: string;
  today: string;
  windowDays: number;
  since?: string;
  instance?: string;
  now: string;
}

// Returns a one-line summary for the launchd log, or undefined when there is nothing to say.
export async function publish(archive: Archive, opts: PublishOptions): Promise<string> {
  const endpoint = endpointFromEnv();
  if (!endpoint) return "publish skipped (CLAUDE_USAGE_OTLP_ENDPOINT/TOKEN unset)";

  const state = await loadState(opts.statePath);
  const handled = new Set<string>(state.handled);
  const { publish: days, tooOld, seed } = select(archive, handled, {
    today: opts.today,
    windowDays: opts.windowDays,
    since: opts.since,
    firstRun: state.handled.length === 0,
  });

  // Named rather than swallowed: these can only be recovered by the promtool block import, and a
  // silent drop is how a gap becomes permanent. Written off with the rest, so it is said once.
  const range = (d: string[]) => (d.length === 1 ? d[0] : `${d[0]}…${d[d.length - 1]}`);
  const skipped = tooOld.length
    ? `; ${tooOld.length} day(s) past the ${opts.windowDays}d window written off (${range(tooOld)}) — only backfill/README.md can recover those`
    : "";

  if (days.length) await send(endpoint, payload(archive, days, opts.instance ?? hostname()));

  // Only after a successful send: a throw above leaves the state untouched so the next run retries.
  if (days.length || tooOld.length || seed.length) {
    await saveState(opts.statePath, {
      updatedAt: opts.now,
      handled: [...handled, ...days, ...tooOld, ...seed].sort(),
    });
  }

  if (!days.length) return `nothing new to publish${skipped}`;
  return `published ${days.length} day(s) to Prometheus (${range(days)})${skipped}`;
}
