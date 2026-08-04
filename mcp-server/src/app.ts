import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { TenantConfig } from "./tenants.js";
import { bearerAuth } from "./auth.js";
import { AuditLog } from "./audit.js";
import { buildMcpServer, buildTenantTools } from "./mcp.js";

export function createApp(tenants: TenantConfig[], audit: AuditLog): express.Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  for (const tenant of tenants) {
    const path = `/${tenant.id}/mcp`;
    // Long-lived per-tenant state (Firebase clients, caches) — shared across requests.
    const tools = buildTenantTools(tenant);

    app.post(path, bearerAuth(tenant, audit), async (req, res) => {
      const identity = res.locals.identity as string;
      const body = req.body;

      // Express 4 does not route async rejections to the error handler — an unhandled one
      // leaves the client hanging with no response at all. Catch everything here.
      try {
        // Audit at the JSON-RPC layer: one line per tools/call, before execution. Deliberately
        // fail-closed: if the call can't be recorded, it doesn't run.
        if (body?.method === "tools/call") {
          await audit.write({
            event: "tool_call",
            tenant: tenant.id,
            identity,
            tool: body.params?.name,
            args: body.params?.arguments,
          });
        }

        // Stateless mode: a fresh server + transport per request. No session state means
        // any request can hit any process — what we want behind a proxy.
        const server = buildMcpServer(tenant, tools, identity);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        console.error(`[${tenant.id}] request failed:`, err);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: body?.id ?? null,
          });
        }
      }
    });

    // Stateless servers have no SSE stream to resume and no session to delete.
    const methodNotAllowed = (_req: express.Request, res: express.Response) => {
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed in stateless mode" },
        id: null,
      });
    };
    app.get(path, bearerAuth(tenant, audit), methodNotAllowed);
    app.delete(path, bearerAuth(tenant, audit), methodNotAllowed);
  }

  return app;
}
