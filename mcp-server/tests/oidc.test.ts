import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { AuditLog } from "../src/audit.js";
import { sha256 } from "../src/auth.js";
import type { TenantConfig } from "../src/tenants.js";

const TOKEN = "dmt_test_token";
const ISSUER = "https://auth.example.com/realms/test";
const PUBLIC_URL = "https://mcp.example.com";

const tenant: TenantConfig = {
  id: "tapempire",
  display: "TapEmpire",
  keys: { "test-key": sha256(TOKEN) },
  allow_emails: ["designer@example.com"],
  tools: { ping: {} },
};

let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  const auditPath = join(mkdtempSync(join(tmpdir(), "audit-oidc-")), "audit.jsonl");
  const app = createApp([tenant], new AuditLog(auditPath), {
    oidcIssuer: ISSUER,
    publicUrl: PUBLIC_URL,
  });
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

describe("protected resource metadata", () => {
  it("advertises the authorization server", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: PUBLIC_URL,
      authorization_servers: [ISSUER],
    });
  });

  // Clients may append the resource path when deriving the metadata URL.
  it("serves the path-suffixed form too", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/tapempire/mcp`);
    expect(res.status).toBe(200);
  });
});

describe("two-tier auth", () => {
  it("still accepts a static API key", async () => {
    const res = await fetch(`${baseUrl}/tapempire/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(200);
  });

  // The 401 must carry resource_metadata, or a GUI client has no way to discover
  // the auth server and start the sign-in flow.
  it("points unauthenticated callers at the metadata document", async () => {
    const res = await fetch(`${baseUrl}/tapempire/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain("/.well-known/oauth-protected-resource/tapempire/mcp");
  });

  it("rejects a malformed OIDC token without hanging", async () => {
    const res = await fetch(`${baseUrl}/tapempire/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer not.a.jwt",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(401);
  });
});
