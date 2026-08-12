import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
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

let auditPath: string;

async function waitFor<T>(check: () => T | null, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = check();
      if (value !== null) return value;
    } catch {
      // file may not exist yet
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for audit entry");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  auditPath = join(mkdtempSync(join(tmpdir(), "audit-oidc-")), "audit.jsonl");
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

  // The reason is the whole point: without it, a bad signature, a stale issuer, a missing
  // audience mapper and an unmapped email claim are one indistinguishable line in the log.
  it("records why a request was denied", async () => {
    await fetch(`${baseUrl}/tapempire/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    await fetch(`${baseUrl}/tapempire/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer dmt_wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    // Denials are written fire-and-forget so a rejected request never waits on disk — poll
    // rather than assuming the write has landed by the time the response arrived.
    const reasons = await waitFor(() => {
      const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const found = lines.filter((l) => l.event === "auth_denied").map((l) => l.reason);
      return found.includes("unknown_key") ? found : null;
    });
    expect(reasons).toContain("no_token");
    expect(reasons).toContain("unknown_key");
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
