import { z } from "zod";
import { BigQueryClient } from "@daemon-tools/bigquery";
import { TTLCache } from "@daemon-tools/firebase";
import type { TenantConfig } from "../tenants.js";
import type { ToolInstance } from "../mcp.js";

// Project and service account come from the tenant's `google:` block; only what is specific to
// this tool lives here.
const configSchema = z.object({
  dataset: z.string().default("firebase_crashlytics"),
  cache_ttl_seconds: z.number().int().positive().default(300),
});

// Table names cannot be query parameters, so they are interpolated — which makes validation the
// only thing standing between a tool argument and arbitrary SQL. Crashlytics names are the app id
// with dots replaced by underscores, plus _ANDROID/_IOS and optionally _REALTIME.
const TABLE_RE = /^[A-Za-z0-9_]+$/;

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createCrashlytics(
  tenant: TenantConfig,
  rawConfig: Record<string, unknown>,
): ToolInstance {
  const config = configSchema.parse(rawConfig);
  const google = tenant.google;
  if (!google) throw new Error(`tenant ${tenant.id}: crashlytics needs a google: block`);
  if (!google.location) {
    throw new Error(`tenant ${tenant.id}: crashlytics needs google.location (BigQuery region)`);
  }
  const client = new BigQueryClient({
    projectId: google.project,
    serviceAccountPath: google.service_account,
    location: google.location,
  });
  const cache = new TTLCache<unknown>(config.cache_ttl_seconds * 1000);

  const qualified = (table: string) => {
    if (!TABLE_RE.test(table)) throw new Error(`invalid table name: ${table}`);
    return `\`${google.project}.${config.dataset}.${table}\``;
  };

  return {
    register(server) {
      server.registerTool(
        "list_crashlytics_tables",
        {
          description:
            "List the Crashlytics export tables in BigQuery — one per app/platform. Tables only " +
            "appear after the first error event is exported, so an empty list means no crashes " +
            "have been recorded since the export was linked, not that it is misconfigured.",
          inputSchema: {},
        },
        async () => asText(await cache.getOrLoad("tables", () => client.listTables(config.dataset))),
      );

      server.registerTool(
        "crashlytics_schema",
        {
          description:
            "Describe the columns of a Crashlytics export table, as dotted paths. Use this before " +
            "reasoning about fields the other tools don't expose — the export's schema is only " +
            "partly documented.",
          inputSchema: { table: z.string() },
        },
        async ({ table }) => {
          if (!TABLE_RE.test(table)) throw new Error(`invalid table name: ${table}`);
          return asText(
            await cache.getOrLoad(`schema:${table}`, () =>
              client.describeTable(config.dataset, table),
            ),
          );
        },
      );

      server.registerTool(
        "top_crashes",
        {
          description:
            "Most frequent Crashlytics issues over a recent window: title, error type, event count, " +
            "how many distinct devices were affected, and the blamed source location.",
          inputSchema: {
            table: z.string(),
            days: z.number().int().positive().max(90).default(7),
            limit: z.number().int().positive().max(100).default(20),
            fatal_only: z.boolean().default(false),
          },
        },
        async ({ table, days, limit, fatal_only }) => {
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
            FROM ${qualified(table)}
            WHERE event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
              ${fatal_only ? "AND is_fatal" : ""}
            GROUP BY issue_id, error_type
            ORDER BY affected_installs DESC, events DESC
            LIMIT @limit`;
          return asText(
            await cache.getOrLoad(`top:${table}:${days}:${limit}:${fatal_only}`, () =>
              client.query(sql, { params: { days, limit } }),
            ),
          );
        },
      );

      server.registerTool(
        "crash_detail",
        {
          description:
            "Breakdown of one Crashlytics issue: affected app versions, devices, OS versions and " +
            "Unity build metadata, plus a sample stack frame. Use after top_crashes to work out " +
            "who is hitting it.",
          inputSchema: {
            table: z.string(),
            issue_id: z.string(),
            days: z.number().int().positive().max(90).default(14),
          },
        },
        async ({ table, issue_id, days }) => {
          const sql = `
            SELECT application.display_version AS app_version,
                   operating_system.display_version AS os_version,
                   device.model AS device_model,
                   ANY_VALUE(unity_metadata.unity_version) AS unity_version,
                   LOGICAL_OR(unity_metadata.debug_build) AS any_debug_build,
                   COUNT(*) AS events,
                   COUNT(DISTINCT installation_uuid) AS affected_installs
            FROM ${qualified(table)}
            WHERE event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
              AND issue_id = @issue_id
            GROUP BY app_version, os_version, device_model
            ORDER BY events DESC
            LIMIT 50`;
          return asText(
            await cache.getOrLoad(`detail:${table}:${issue_id}:${days}`, () =>
              client.query(sql, { params: { days, issue_id } }),
            ),
          );
        },
      );

      server.registerTool(
        "crashes_by_version",
        {
          description:
            "Crashlytics event counts grouped by app version and error type, over a recent window. " +
            "Answers whether a release is worse than the one before it.",
          inputSchema: {
            table: z.string(),
            days: z.number().int().positive().max(90).default(14),
          },
        },
        async ({ table, days }) => {
          const sql = `
            SELECT application.display_version AS version,
                   error_type,
                   COUNT(*) AS events,
                   COUNT(DISTINCT issue_id) AS distinct_issues,
                   COUNT(DISTINCT installation_uuid) AS affected_installs
            FROM ${qualified(table)}
            WHERE event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
            GROUP BY version, error_type
            ORDER BY events DESC`;
          return asText(
            await cache.getOrLoad(`versions:${table}:${days}`, () =>
              client.query(sql, { params: { days } }),
            ),
          );
        },
      );
    },
  };
}
