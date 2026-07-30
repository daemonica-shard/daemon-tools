import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TenantConfig } from "./tenants.js";
import { createPing } from "./tools/ping.js";
import { createLivedoc } from "./tools/livedoc.js";

// A tool instance is created once per tenant at startup and holds long-lived state
// (Firebase clients, caches). Registration happens per request, because in stateless
// mode each request gets a fresh McpServer.
export interface ToolInstance {
  register(server: McpServer, identity: string): void;
}

type ToolFactory = (tenant: TenantConfig, config: Record<string, unknown>) => ToolInstance;

// Tool catalog: a tenant gets a tool by listing its name under `tools:` in tenants.yaml.
const catalog: Record<string, ToolFactory> = {
  ping: createPing,
  livedoc: createLivedoc,
};

export function buildTenantTools(tenant: TenantConfig): ToolInstance[] {
  return Object.entries(tenant.tools).map(([toolName, config]) => {
    const factory = catalog[toolName];
    if (!factory) throw new Error(`tenant ${tenant.id}: unknown tool "${toolName}"`);
    return factory(tenant, config as Record<string, unknown>);
  });
}

export function buildMcpServer(
  tenant: TenantConfig,
  tools: ToolInstance[],
  identity: string,
): McpServer {
  const server = new McpServer({ name: `daemon-tools/${tenant.id}`, version: "0.1.0" });
  for (const tool of tools) tool.register(server, identity);
  return server;
}
