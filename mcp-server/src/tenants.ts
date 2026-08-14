import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

// A tenant id is its URL path prefix: "tapempire" → /tapempire/mcp,
// "daemonica/sway" → /daemonica/sway/mcp.
const tenantIdSchema = z
  .string()
  .regex(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/, "lowercase segments separated by /");

// Shared by every Google-backed tool in a tenant. Hoisted here because the project and key are
// properties of the tenant, not of each tool — repeating them per tool invites them to drift.
const googleSchema = z.object({
  project: z.string(),
  service_account: z.string(),
  // BigQuery dataset location, e.g. "me-central1". Only needed by tools that query BigQuery;
  // BigQuery defaults to US and a mismatch fails with a "not found" that reads like a
  // permissions error.
  location: z.string().optional(),
});

export type GoogleConfig = z.infer<typeof googleSchema>;

const tenantSchema = z.object({
  display: z.string(),
  google: googleSchema.optional(),
  // key name → sha256 hex of the bearer token. Names identify callers in the audit log.
  keys: z.record(z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex")).default({}),
  // Reserved for the Google OAuth tier.
  allow_emails: z.array(z.string().email()).default([]),
  // tool name → tool-specific config, passed to the tool factory verbatim.
  tools: z.record(z.record(z.unknown())).default({}),
});

const configSchema = z.object({
  tenants: z.record(tenantIdSchema, tenantSchema),
});

export type TenantConfig = z.infer<typeof tenantSchema> & { id: string };

export function loadTenants(path: string): TenantConfig[] {
  const raw = parse(readFileSync(path, "utf8"));
  const config = configSchema.parse(raw);
  return Object.entries(config.tenants).map(([id, tenant]) => ({ id, ...tenant }));
}
