import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { AuditLog } from "../src/audit.js";
import { sha256 } from "../src/auth.js";
import type { TenantConfig } from "../src/tenants.js";

const TOKEN = "dmt_test_token";
const tenant: TenantConfig = {
  id: "daemonica/sway",
  display: "Sway",
  keys: { "test-key": sha256(TOKEN) },
  allow_emails: [],
  tools: { ping: {} },
};

let httpServer: Server;
let baseUrl: string;
let auditPath: string;

beforeAll(async () => {
  auditPath = join(mkdtempSync(join(tmpdir(), "audit-")), "audit.jsonl");
  const app = createApp([tenant], new AuditLog(auditPath));
  await new Promise<void>((resolve) => {
    httpServer = app.listen(0, resolve);
  });
  const address = httpServer.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  httpServer.close();
});

function connect(token?: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/daemonica/sway/mcp`),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
  );
  const client = new Client({ name: "e2e-test", version: "0.0.0" });
  return client.connect(transport).then(() => client);
}

describe("mcp endpoint", () => {
  it("rejects requests without a valid key", async () => {
    await expect(connect()).rejects.toThrow(/unauthorized/);
    await expect(connect("dmt_wrong")).rejects.toThrow(/unauthorized/);
  });

  it("lists and calls tools with a valid key, and audits the call", async () => {
    const client = await connect(TOKEN);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("ping");

      const result = await client.callTool({
        name: "ping",
        arguments: { message: "hello" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toBe("pong from daemonica/sway (caller: test-key): hello");
    } finally {
      await client.close();
    }

    const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const call = lines.find((l) => l.event === "tool_call");
    expect(call).toMatchObject({
      tenant: "daemonica/sway",
      identity: "test-key",
      tool: "ping",
      args: { message: "hello" },
    });
    expect(lines.some((l) => l.event === "auth_denied")).toBe(true);
  });

  it("404s unknown tenants", async () => {
    const res = await fetch(`${baseUrl}/nope/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(res.status).toBe(404);
  });
});
