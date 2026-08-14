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
            "Most frequent Crashlytics issues over a recent window, by event count. Returns issue " +
            "ids with their error type and first/last seen timestamps.",
          inputSchema: {
            table: z.string(),
            days: z.number().int().positive().max(90).default(7),
            limit: z.number().int().positive().max(100).default(20),
          },
        },
        async ({ table, days, limit }) => {
          const sql = `
            SELECT issue_id,
                   error_type,
                   COUNT(*) AS events,
                   MIN(event_timestamp) AS first_seen,
                   MAX(event_timestamp) AS last_seen
            FROM ${qualified(table)}
            WHERE event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
            GROUP BY issue_id, error_type
            ORDER BY events DESC
            LIMIT @limit`;
          return asText(
            await cache.getOrLoad(`top:${table}:${days}:${limit}`, () =>
              client.query(sql, { params: { days, limit } }),
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
                   COUNT(DISTINCT issue_id) AS distinct_issues
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
