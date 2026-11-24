import { setTimeout as delay } from "node:timers/promises";

// AppLovin's Reporting API: aggregated stats as CSV, one row per combination of the requested
// columns. The advertiser report is the UA side (what campaigns spent and bought); the publisher
// report is the MAX side.
//
// It only reaches back 45 days ("Start date is beyond our 45 day look back period"), so anything
// older is gone unless it was saved. Days are UTC. Cost comes as text with a dollar sign ("$12.34").
//
// https://support.applovin.com/en/growth/promoting-your-apps/api/reporting-api

export const REPORT_URL = "https://r.applovin.com/report";
export const LOOKBACK_DAYS = 45;

export interface ReportRequest {
  reportType: "advertiser" | "publisher";
  /** First and last day, yyyy-mm-dd (UTC), both included. */
  start: string;
  end: string;
  columns: readonly string[];
}

export interface AppLovinReportingOptions {
  /** The account's Report Key. */
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after a network error or a 5xx answer. Default 3. */
  retries?: number;
}

export class AppLovinError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when no answer came back. */
    readonly status: number,
  ) {
    super(message);
    this.name = "AppLovinError";
  }
}

const NAME_RE = /^[a-z0-9_]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The key has to travel in the URL (AppLovin accepts nothing else), so this never puts the URL in
 * an error, and scrubs the key out of anything the server says back.
 */
export class AppLovinReporting {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retries: number;

  constructor(options: AppLovinReportingOptions) {
    if (!options.apiKey) throw new Error("AppLovin's Reporting API needs a Report Key");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.retries = options.retries ?? 3;
  }

  /** The report as AppLovin's CSV text. */
  async report(req: ReportRequest): Promise<string> {
    if (!DATE_RE.test(req.start) || !DATE_RE.test(req.end)) throw new Error(`Dates must be yyyy-mm-dd: got ${req.start} to ${req.end}`);
    if (req.columns.length === 0) throw new Error("A report needs at least one column");
    for (const column of req.columns) if (!NAME_RE.test(column)) throw new Error(`Invalid column name: ${column}`);
    const params = new URLSearchParams({
      api_key: this.apiKey,
      start: req.start,
      end: req.end,
      format: "csv",
      report_type: req.reportType,
      columns: req.columns.join(","),
    });
    const url = `${REPORT_URL}?${params}`;
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let reason: string;
      try {
        const res = await this.fetchImpl(url);
        const text = await res.text();
        if (res.ok) return text;
        status = res.status;
        reason = this.scrub(text.trim()).slice(0, 300);
        if (res.status < 500) {
          throw new AppLovinError(`AppLovin answered ${res.status} to the ${req.reportType} report: ${reason}`, res.status);
        }
      } catch (err) {
        if (err instanceof AppLovinError) throw err;
        // fetch puts the URL, and with it the key, in some of its errors.
        reason = this.scrub(err instanceof Error ? err.message : String(err));
      }
      if (attempt >= this.retries) {
        throw new AppLovinError(`AppLovin failed ${attempt + 1} times in a row, last with: ${reason}`, status);
      }
      await this.sleep(10_000 * (attempt + 1));
    }
  }

  private scrub(text: string): string {
    return text.split(this.apiKey).join("<report key>");
  }
}
