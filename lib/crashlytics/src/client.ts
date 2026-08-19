import { BigQueryClient, type BigQueryConfig, type TableField } from "@daemon-tools/bigquery";

export interface CrashlyticsConfig extends BigQueryConfig {
  /** Firebase creates this dataset when the BigQuery export is linked. */
  dataset?: string;
}

// Table names cannot be query parameters, so they are interpolated — which makes this regex the
// only thing standing between a caller-supplied name and arbitrary SQL. Crashlytics names are the
// app id with dots replaced by underscores, plus _ANDROID/_IOS and optionally _REALTIME.
const TABLE_RE = /^[A-Za-z0-9_]+$/;

/** BigQuery hands TIMESTAMP columns back boxed rather than as a bare string. */
export interface BigQueryTimestamp {
  value: string;
}

export interface TopCrash {
  issue_id: string;
  title: string | null;
  subtitle: string | null;
  error_type: string;
  fatal: boolean;
  events: number;
  affected_installs: number;
  blame_file: string | null;
  blame_symbol: string | null;
  blame_line: number | null;
  first_seen: BigQueryTimestamp;
  last_seen: BigQueryTimestamp;
}

export interface VersionRow {
  version: string | null;
  error_type: string;
  events: number;
  distinct_issues: number;
  affected_installs: number;
}

export interface CrashDetailRow {
  app_version: string | null;
  os_version: string | null;
  device_model: string | null;
  unity_version: string | null;
  any_debug_build: boolean | null;
  events: number;
  affected_installs: number;
}

/**
 * The Crashlytics BigQuery export, as queries rather than as MCP tools.
 *
 * Shared deliberately: the MCP tool and the digest job ask the same questions of the same export,
 * and a second copy of this SQL would drift from the first the moment either one is tuned.
 */
export class CrashlyticsClient {
  private readonly bq: BigQueryClient;
  private readonly dataset: string;
  private readonly projectId: string;

  constructor(config: CrashlyticsConfig) {
    this.bq = new BigQueryClient(config);
    this.dataset = config.dataset ?? "firebase_crashlytics";
    this.projectId = config.projectId;
  }

  private qualified(table: string): string {
    if (!TABLE_RE.test(table)) throw new Error(`invalid table name: ${table}`);
    return `\`${this.projectId}.${this.dataset}.${table}\``;
  }

  listTables(): Promise<string[]> {
    return this.bq.listTables(this.dataset);
  }

  describeTable(table: string): Promise<TableField[]> {
    if (!TABLE_RE.test(table)) throw new Error(`invalid table name: ${table}`);
    return this.bq.describeTable(this.dataset, table);
  }

  /**
   * The batch tables (no `_REALTIME` suffix) are the canonical ones: they carry history and are
   * backfilled up to 30 days, while the realtime partitions expire after 30 days and are never
   * backfilled. Anything reporting on a window wants these.
   */
  async batchTables(): Promise<string[]> {
    return (await this.listTables()).filter((t) => !t.endsWith("_REALTIME"));
  }

  topCrashes(opts: {
    table: string;
    days?: number;
    limit?: number;
    fatalOnly?: boolean;
  }): Promise<TopCrash[]> {
    const { table, days = 7, limit = 20, fatalOnly = false } = opts;
    // affected_installs matters more than event count for triage: one device in a crash loop
    // can dominate the event count while affecting nobody else.
    const sql = `
      SELECT issue_id,
             ANY_VALUE(issue_title) AS title,
             ANY_VALUE(issue_subtitle) AS subtitle,
             error_type,
             LOGICAL_OR(is_fatal) AS fatal,
             COUNT(*) AS events,
             COUNT(DISTINCT installation_uuid) AS affected_installs,
             ANY_VALUE(blame_frame.file) AS blame_file,
             ANY_VALUE(blame_frame.symbol) AS blame_symbol,
             ANY_VALUE(blame_frame.line) AS blame_line,
             MIN(event_timestamp) AS first_seen,
             MAX(event_timestamp) AS last_seen
      FROM ${this.qualified(table)}
      WHERE event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        ${fatalOnly ? "AND is_fatal" : ""}
      GROUP BY issue_id, error_type
      ORDER BY affected_installs DESC, events DESC
      LIMIT @limit`;
    return this.bq.query<TopCrash>(sql, { params: { days, limit } });
  }

  crashDetail(opts: { table: string; issueId: string; days?: number }): Promise<CrashDetailRow[]> {
    const { table, issueId, days = 14 } = opts;
    const sql = `
      SELECT application.display_version AS app_version,
             operating_system.display_version AS os_version,
             device.model AS device_model,
             ANY_VALUE(unity_metadata.unity_version) AS unity_version,
             LOGICAL_OR(unity_metadata.debug_build) AS any_debug_build,
             COUNT(*) AS events,
             COUNT(DISTINCT installation_uuid) AS affected_installs
      FROM ${this.qualified(table)}
      WHERE event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        AND issue_id = @issue_id
      GROUP BY app_version, os_version, device_model
      ORDER BY events DESC
      LIMIT 50`;
    return this.bq.query<CrashDetailRow>(sql, { params: { days, issue_id: issueId } });
  }

  crashesByVersion(opts: { table: string; days?: number }): Promise<VersionRow[]> {
    const { table, days = 14 } = opts;
    const sql = `
      SELECT application.display_version AS version,
             error_type,
             COUNT(*) AS events,
             COUNT(DISTINCT issue_id) AS distinct_issues,
             COUNT(DISTINCT installation_uuid) AS affected_installs
      FROM ${this.qualified(table)}
      WHERE event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      GROUP BY version, error_type
      ORDER BY events DESC`;
    return this.bq.query<VersionRow>(sql, { params: { days } });
  }
}

/**
 * `com_tapempire_wordgame_ANDROID` → `{ app: "wordgame", platform: "Android" }`.
 *
 * The export names a table after the bundle id with dots replaced by underscores, so the segment
 * before the platform suffix is the only human-readable part available without a lookup.
 */
export function describeTableName(table: string): {
  app: string;
  platform: string;
  realtime: boolean;
} {
  const realtime = table.endsWith("_REALTIME");
  const base = realtime ? table.slice(0, -"_REALTIME".length) : table;
  const match = /^(.*)_(ANDROID|IOS)$/.exec(base);
  if (!match) return { app: base, platform: "unknown", realtime };
  const [, prefix, platform] = match;
  return {
    app: prefix.split("_").pop() ?? prefix,
    platform: platform === "IOS" ? "iOS" : "Android",
    realtime,
  };
}
