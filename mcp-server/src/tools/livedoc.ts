import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RemoteConfigClient, TTLCache } from "@daemon-tools/firebase";
import type { TenantConfig } from "../tenants.js";
import type { ToolInstance } from "../mcp.js";

// Ported from the standalone LiveDoc server, parameterized per tenant: each tenant
// brings its own Firebase project, service account, and features file.
const configSchema = z.object({
  firebase_project: z.string(),
  firebase_sa: z.string(),
  features_file: z.string().optional(),
  cache_ttl_seconds: z.number().int().positive().default(300),
});

const featureSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string().optional(),
  description: z.string().optional(),
  firebase: z.array(z.string()).default([]),
  unity: z.array(z.string()).default([]),
  code_markers: z.array(z.string()).default([]),
});

const featuresFileSchema = z.object({ features: z.array(featureSchema) });

function loadFeatures(path: string | undefined): z.infer<typeof featureSchema>[] {
  if (!path || !existsSync(path)) return [];
  return featuresFileSchema.parse(parseYaml(readFileSync(path, "utf8"))).features;
}

function asText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createLivedoc(tenant: TenantConfig, rawConfig: Record<string, unknown>): ToolInstance {
  const config = configSchema.parse(rawConfig);
  const client = new RemoteConfigClient({
    projectId: config.firebase_project,
    serviceAccountPath: config.firebase_sa,
  });
  const cache = new TTLCache<unknown>(config.cache_ttl_seconds * 1000);

  return {
    register(server) {
      server.registerTool(
        "list_firebase_versions",
        {
          description:
            "List recent Firebase Remote Config publish versions (template history). Cached in-memory.",
          inputSchema: { pageSize: z.number().int().positive().max(300).default(50) },
        },
        async ({ pageSize }) => {
          const versions = await cache.getOrLoad(`versions:${pageSize}`, () =>
            client.listVersions(pageSize),
          );
          return asText(versions);
        },
      );

      server.registerTool(
        "get_firebase_template",
        {
          description:
            "Fetch the full Firebase Remote Config template. Defaults to the currently published version; pass versionNumber for a historical template.",
          inputSchema: { versionNumber: z.string().optional() },
        },
        async ({ versionNumber }) => {
          const template = await cache.getOrLoad(`template:${versionNumber ?? "current"}`, () =>
            client.getTemplate(versionNumber),
          );
          return asText(template);
        },
      );

      server.registerTool(
        "list_features",
        {
          description:
            "List features declared in this project's features file — tracked features with their Firebase keys, Unity configs, and code markers.",
          inputSchema: {},
        },
        async () => asText(loadFeatures(config.features_file)),
      );
    },
  };
}
