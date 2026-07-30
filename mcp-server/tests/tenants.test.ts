import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTenants } from "../src/tenants.js";

function writeConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tenants-"));
  const path = join(dir, "tenants.yaml");
  writeFileSync(path, yaml);
  return path;
}

describe("loadTenants", () => {
  it("parses tenants with nested ids", () => {
    const path = writeConfig(`
tenants:
  tapempire:
    display: TapEmpire
    tools:
      ping: {}
  daemonica/sway:
    display: Sway
`);
    const tenants = loadTenants(path);
    expect(tenants.map((t) => t.id)).toEqual(["tapempire", "daemonica/sway"]);
    expect(tenants[0].tools).toHaveProperty("ping");
    expect(tenants[1].keys).toEqual({});
  });

  it("rejects malformed tenant ids", () => {
    const path = writeConfig(`
tenants:
  "Bad Tenant!":
    display: nope
`);
    expect(() => loadTenants(path)).toThrow();
  });

  it("rejects non-sha256 key hashes", () => {
    const path = writeConfig(`
tenants:
  t:
    display: T
    keys:
      dev: "not-a-hash"
`);
    expect(() => loadTenants(path)).toThrow();
  });
});
