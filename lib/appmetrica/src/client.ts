import { setTimeout as delay } from "node:timers/promises";

// AppMetrica's Logs API serves raw rows: one per event, ad impression, session start, install …
//
// Exports are asynchronous. The first request queues the file and answers 202; the identical request
// keeps answering 202 until the file is ready, then 200 with the file. At most 3 exports per app can
// be queued at once (a 4th gets 429). A prepared file is served for 24 hours to every identical
// request, so a caller that needs rows newer than that file says how old a file it accepts
// (Cache-Control: max-age).
//
// https://appmetrica.yandex.com/docs/en/mobile-api/logs/request-procedure

export const DEFAULT_BASE_URL = "https://api.appmetrica.yandex.com";

/** Every table the Logs API exports, at /logs/v1/export/<table>.csv or .json. */
export const LOGS_TABLES = [
  "ad_revenue_events",
  "events",
  "sessions_starts",
  "installations",
  "revenue_events",
  "ecommerce_events",
  "profiles_v2",
  "clicks",
  "postbacks",
  "deeplinks",
  "push_tokens",
  "crashes",
  "errors",
] as const;
export type LogsTable = (typeof LOGS_TABLES)[number];

export interface Application {
  id: number;
  name: string;
  /** IANA name, e.g. Europe/Moscow. Export date ranges are read in this zone. */
  timeZoneName: string;
  /** Seconds east of UTC. */
  timeZoneOffset: number;
  /** view, edit, agency_view, agency_edit or own. */
  permission: string;
}

export interface ExportRequest {
  applicationId: number;
  table: LogsTable;
  /** Start of the range: "yyyy-mm-dd hh:mm:ss" in the app's time zone. */
  since: string;
  /** End of the range, in the same format. */
  until: string;
  fields: readonly string[];
  /** Which time the range applies to: "default" = on the device, "receive" = arrival at AppMetrica. */
  dateDimension?: "default" | "receive";
  format?: "csv" | "json";
  /** Only rows whose field equals the value (the API supports nothing but equality). */
  filters?: Readonly<Record<string, string>>;
  /**
   * Accept a prepared file only if it is at most this many seconds old, otherwise have a new one
   * prepared. Unset, an identical request's file from the last 24 hours is served as it is.
   */
  maxAgeSeconds?: number;
}

export interface ExportFile {
  /** The file, already decompressed. It can be read once. */
  body: ReadableStream<Uint8Array>;
  /**
   * The Shards-Unavailable header: the percentage of storage shards AppMetrica couldn't read. Above
   * 0, the file is missing rows and should be fetched again later. Complete exports come without
   * the header, so a missing header reads as 0.
   */
  shardsUnavailable: number;
  /** The file's row count, from the Rows-Number header (not in the docs); null when it was absent. */
  rows: number | null;
  /** Requests made, including the one that returned the file. */
  polls: number;
  waitedMs: number;
}

export interface ExportWait {
  /**
   * preparing: queued or being built (202). queue-full: 3 exports are already queued for the app
   * (429). retrying: a server or network error, about to be retried.
   */
  reason: "preparing" | "queue-full" | "retrying";
  polls: number;
  waitedMs: number;
  nextPollMs: number;
  /** What the server said, e.g. "Wait for result". */
  detail: string;
}

export interface ExportOptions {
  signal?: AbortSignal;
  /** Called before every wait. */
  onWait?: (wait: ExportWait) => void;
}

export interface ActiveQuery {
  requestId: string;
  /** The table, as AppMetrica numbers them: 2 = events, 7 = sessions_starts, 13 = ad_revenue_events … */
  entity: number;
  /** 0 = created, 1 = processed. */
  status: number;
  /** 0 to 1. */
  progress: number;
  rowsLoaded: number;
  createTime: string;
  /** The request's query string. */
  query: string;
}

export interface AppMetricaClientOptions {
  /** OAuth token with the appmetrica:read permission. */
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Give up waiting for an export after this long. Default 2 hours. */
  exportTimeoutMs?: number;
  /** Retries of one request after a network error or a 5xx answer. Default 4. */
  retries?: number;
}

export class AppMetricaError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when no answer came back. */
    readonly status: number,
  ) {
    super(message);
    this.name = "AppMetricaError";
  }
}

const NAME_RE = /^[a-z0-9_]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/;
// Query parameters of the export itself. Filters are passed as plain field=value parameters, so a
// filter can't be allowed to take one of these names.
const RESERVED = new Set([
  "application_id",
  "date_since",
  "date_until",
  "date_dimension",
  "fields",
  "limit",
  "use_utf8_bom",
  "skip_unavailable_shards",
]);
const RETRY_DELAY_MS = 15_000;

interface RawApplication {
  id: number;
  name: string;
  time_zone_name: string;
  time_zone_offset: number;
  permission: string;
}

interface RawActiveQuery {
  request_id: string;
  entity: number;
  status: number;
  total_progress: number;
  total_rows_loaded: number;
  create_time: string;
  query: string;
}

/**
 * The Logs API plus the Management API calls that go with it. Every request carries the token in
 * the Authorization header, never in the URL, so URLs and error messages are safe to log.
 */
export class AppMetricaClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly exportTimeoutMs: number;
  private readonly retries: number;

  constructor(options: AppMetricaClientOptions) {
    if (!options.token) throw new Error("AppMetrica needs an OAuth token");
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.now = options.now ?? Date.now;
    this.exportTimeoutMs = options.exportTimeoutMs ?? 2 * 60 * 60_000;
    this.retries = options.retries ?? 4;
  }

  /** Every app the token's account can read, agency apps included. */
  async listApplications(): Promise<Application[]> {
    const res = await this.request("/management/v1/applications?include_agency_apps=true", "app list");
    const body = (await res.json()) as { applications?: RawApplication[] };
    return (body.applications ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      timeZoneName: a.time_zone_name,
      timeZoneOffset: a.time_zone_offset,
      permission: a.permission,
    }));
  }

  /** "enabled", or "disabled" while AppMetrica's Logs API is down. */
  async logsApiStatus(): Promise<string> {
    const res = await this.request("/management/v1/logsapi/status", "Logs API status");
    const body = (await res.json()) as { logs_api_availability_status?: string };
    return body.logs_api_availability_status ?? "unknown";
  }

  /** Exports still queued or being prepared for the app: the ones counting toward its limit of 3. */
  async activeQueries(applicationId: number): Promise<ActiveQuery[]> {
    const path = `/logs/v1/export/get_active_queries?${query({ application_id: String(applicationId) })}`;
    const rows = (await (await this.request(path, "active export list")).json()) as RawActiveQuery[];
    return rows.map((q) => ({
      requestId: q.request_id,
      entity: q.entity,
      status: q.status,
      progress: q.total_progress,
      rowsLoaded: q.total_rows_loaded,
      createTime: q.create_time,
      query: q.query,
    }));
  }

  /** Cancels a queued export. Returns AppMetrica's message, e.g. that it was already complete. */
  async cancelQuery(applicationId: number, requestId: string): Promise<string> {
    const path = `/logs/v1/export/${encodeURIComponent(requestId)}/cancel?${query({ application_id: String(applicationId) })}`;
    const res = await this.request(path, "cancel request", { method: "POST" });
    // The live API answers in plain text ("Request cancellation has been scheduled."), not JSON.
    const text = (await res.text()).trim();
    try {
      const body = JSON.parse(text) as { message?: string };
      return body.message ?? text;
    } catch {
      return text;
    }
  }

  exportUrl(req: ExportRequest): string {
    if (!(LOGS_TABLES as readonly string[]).includes(req.table)) throw new Error(`Unknown Logs API table: ${req.table}`);
    if (!Number.isInteger(req.applicationId) || req.applicationId <= 0) {
      throw new Error(`Invalid application id: ${req.applicationId}`);
    }
    if (!DATE_RE.test(req.since) || !DATE_RE.test(req.until)) {
      throw new Error(`Dates must be "yyyy-mm-dd hh:mm:ss": got ${req.since} to ${req.until}`);
    }
    if (req.fields.length === 0) throw new Error("An export needs at least one field");
    for (const field of req.fields) if (!NAME_RE.test(field)) throw new Error(`Invalid field name: ${field}`);
    const params: Record<string, string> = {
      application_id: String(req.applicationId),
      date_since: req.since,
      date_until: req.until,
      fields: req.fields.join(","),
      // Without it, an export waits until every shard is back. With it, the export comes back
      // without the missing shards' rows and says so in Shards-Unavailable, which callers check.
      skip_unavailable_shards: "true",
    };
    if (req.dateDimension) params.date_dimension = req.dateDimension;
    for (const [field, value] of Object.entries(req.filters ?? {})) {
      if (!NAME_RE.test(field) || RESERVED.has(field)) throw new Error(`Invalid filter field: ${field}`);
      params[field] = value;
    }
    return `${this.baseUrl}/logs/v1/export/${req.table}.${req.format ?? "csv"}?${query(params)}`;
  }

  /**
   * Requests an export and repeats the identical request until the file is ready, then returns it.
   * Waits out a full queue too. Throws AppMetricaError on any other answer, and after
   * exportTimeoutMs; the export then stays queued on AppMetrica's side (see activeQueries).
   */
  async exportLogs(req: ExportRequest, options: ExportOptions = {}): Promise<ExportFile> {
    const url = this.exportUrl(req);
    const headers: Record<string, string> = {};
    if (req.maxAgeSeconds !== undefined) {
      headers["Cache-Control"] = `max-age=${Math.max(0, Math.floor(req.maxAgeSeconds))}`;
    }
    const started = this.now();
    for (let polls = 1; ; polls++) {
      const res = await this.send(url, { headers, signal: options.signal }, options);
      const waitedMs = this.now() - started;
      if (res.status === 200) {
        return {
          body: res.body ?? emptyStream(),
          shardsUnavailable: parseNumber(res.headers.get("Shards-Unavailable")) ?? 0,
          rows: parseNumber(res.headers.get("Rows-Number")),
          polls,
          waitedMs,
        };
      }
      if (res.status !== 202 && res.status !== 429) throw await failure(res, `${req.table} export`);
      const detail = (await res.text()).trim();
      if (waitedMs >= this.exportTimeoutMs) {
        throw new AppMetricaError(
          `AppMetrica was still preparing the ${req.table} export after ${Math.round(waitedMs / 60_000)} min. ` +
            "It stays queued on their side until it finishes or is cancelled.",
          res.status,
        );
      }
      const nextPollMs = pollDelay(polls);
      options.onWait?.({ reason: res.status === 202 ? "preparing" : "queue-full", polls, waitedMs, nextPollMs, detail });
      await this.sleep(nextPollMs, options.signal);
    }
  }

  private async request(path: string, what: string, init: { method?: string } = {}): Promise<Response> {
    const res = await this.send(this.baseUrl + path, init, {});
    if (!res.ok) throw await failure(res, what);
    return res;
  }

  /** One request, retried after network errors and 5xx answers. Any other answer is returned as it is. */
  private async send(
    url: string,
    init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
    options: ExportOptions,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let reason: string;
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          headers: { ...init.headers, Authorization: `OAuth ${this.token}` },
        });
        if (res.status < 500) return res;
        status = res.status;
        reason = `${res.status} ${(await res.text().catch(() => "")).trim().slice(0, 200)}`.trim();
      } catch (err) {
        if (init.signal?.aborted) throw err;
        reason = err instanceof Error ? err.message : String(err);
      }
      if (attempt >= this.retries) {
        throw new AppMetricaError(`AppMetrica failed ${attempt + 1} times in a row, last with: ${reason}`, status);
      }
      const nextPollMs = RETRY_DELAY_MS * (attempt + 1);
      options.onWait?.({ reason: "retrying", polls: attempt + 1, waitedMs: 0, nextPollMs, detail: reason });
      await this.sleep(nextPollMs, init.signal);
    }
  }
}

// AppMetrica's own samples encode spaces as %20 (not +) and commas and colons too, so this does
// the same rather than trusting the server to read URLSearchParams' form encoding.
function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** 5 s, then 1.5× longer each time, up to a minute. The docs give no interval. */
function pollDelay(polls: number): number {
  return Math.min(60_000, Math.round(5_000 * 1.5 ** (polls - 1)));
}

function parseNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
}

async function failure(res: Response, what: string): Promise<AppMetricaError> {
  const text = (await res.text().catch(() => "")).trim();
  // Errors come as JSON ({"errors":[{"error_type":"invalid_token",…}],"code":403,"message":"Invalid oauth_token"})
  // or as plain text.
  let message = text.slice(0, 500);
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // plain text
  }
  // The docs promise 401 for a bad token; the API actually answers 403 with error_type invalid_token.
  const badToken = res.status === 401 || /invalid_token|invalid oauth/i.test(text);
  const hint = badToken
    ? " The OAuth token is missing, invalid, expired or revoked."
    : res.status === 403
      ? " The token's Yandex account may not have access to this app."
      : "";
  return new AppMetricaError(`AppMetrica answered ${res.status} to the ${what}.${hint}${message ? ` (${message})` : ""}`, res.status);
}
