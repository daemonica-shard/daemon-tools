import { z } from "zod";
import type { TenantConfig } from "../tenants.js";
import type { ToolInstance } from "../mcp.js";

// Smoke-test tool: proves transport, auth, and per-tenant wiring end to end.
export function createPing(tenant: TenantConfig): ToolInstance {
  return {
    register(server, identity) {
      server.registerTool(
        "ping",
        {
          description: "Health check. Echoes the message back with tenant and caller identity.",
          inputSchema: { message: z.string().optional() },
        },
        async ({ message }) => ({
          content: [
            {
              type: "text" as const,
              text: `pong from ${tenant.id} (caller: ${identity})${message ? `: ${message}` : ""}`,
            },
          ],
        }),
      );
    },
  };
}
