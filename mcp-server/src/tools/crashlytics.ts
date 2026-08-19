import { z } from "zod";
import { CrashlyticsClient } from "@daemon-tools/crashlytics";
import { TTLCache } from "@daemon-tools/firebase";
import type { TenantConfig } from "../tenants.js";
import type { ToolInstance } from "../mcp.js";

// Project and service account come from the tenant's `google:` block; only what is specific to
// this tool lives here.
const configSchema = z.object({
  dataset: z.string().default("firebase_crashlytics"),
  cache_ttl_seconds: z.number().int().positive().default(300),
});

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
  // The queries live in @daemon-tools/crashlytics so the digest job asks the export the same
  // questions this tool does. Caching stays here: it exists to keep an interactive client from
  // re-billing the same scan, which a once-a-day job has no need of.
  const crashlytics = new CrashlyticsClient({
    projectId: google.project,
    serviceAccountPath: google.service_account,
    location: google.location,
    dataset: config.dataset,
  });
  const cache = new TTLCache<unknown>(config.cache_ttl_seconds * 1000);

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
        async () => asText(await cache.getOrLoad("tables", () => crashlytics.listTables())),
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
        async ({ table }) =>
          asText(
            await cache.getOrLoad(`schema:${table}`, () => crashlytics.describeTable(table)),
          ),
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
        async ({ table, days, limit, fatal_only }) =>
          asText(
            await cache.getOrLoad(`top:${table}:${days}:${limit}:${fatal_only}`, () =>
              crashlytics.topCrashes({ table, days, limit, fatalOnly: fatal_only }),
            ),
          ),
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
        async ({ table, issue_id, days }) =>
          asText(
            await cache.getOrLoad(`detail:${table}:${issue_id}:${days}`, () =>
              crashlytics.crashDetail({ table, issueId: issue_id, days }),
            ),
          ),
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
        async ({ table, days }) =>
          asText(
            await cache.getOrLoad(`versions:${table}:${days}`, () =>
              crashlytics.crashesByVersion({ table, days }),
            ),
          ),
      );
    },
  };
}
