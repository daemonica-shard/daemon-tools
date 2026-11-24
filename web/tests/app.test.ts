import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, fileName } from "../src/app.js";
import { ExportStore } from "../src/store.js";

const PAGE = "<!doctype html><title>forecast</title>";
const NAME = "2026-03-31_adjust_report_export.csv";
const CSV = [
  "day,installs,cost,retention_rate_d1,retention_rate_d7,roas_d0,roas_d7",
  "2026-03-01,10,20,0.3,0.1,0.1,0.2",
  "2026-03-02,12,24,0.35,0.12,0.1,0.25",
].join("\n");

let server: Server;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "web-exports-"));
  const app = createApp({ roasPage: PAGE, roasExports: new ExportStore(dir, 2), maxUpload: 4096 });
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

function upload(body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/roas-forecast/api/export`, {
    method: "POST",
    body,
    headers: { "Content-Type": "text/csv", "X-File-Name": encodeURIComponent(NAME), ...headers },
  });
}

describe("web", () => {
  it("serves the forecast under /roas-forecast/ and nothing at the root", async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    const bare = await fetch(`${base}/roas-forecast`, { redirect: "manual" });
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe("/roas-forecast/");
    const page = await fetch(`${base}/roas-forecast/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("has nothing to share before the first upload", async () => {
    expect((await fetch(`${base}/roas-forecast/api/export`)).status).toBe(204);
  });

  it("serves everyone the latest upload and keeps only the newest few", async () => {
    const first = await upload(CSV);
    expect(first.status).toBe(201);
    const saved = await first.json();
    expect(saved.name).toBe(NAME);
    expect(Number.isNaN(Date.parse(saved.uploadedAt))).toBe(false);

    const second = CSV.replace("2026-03-02,12", "2026-03-02,13");
    const third = CSV.replace("2026-03-02,12", "2026-03-02,14");
    expect((await upload(second)).status).toBe(201);
    expect((await upload(third, { "X-File-Name": "2026-04-01_export.csv" })).status).toBe(201);

    const shared = await fetch(`${base}/roas-forecast/api/export`);
    expect(shared.headers.get("cache-control")).toBe("no-store");
    expect(await shared.json()).toMatchObject({ name: "2026-04-01_export.csv", csv: third });
    // This store keeps two, so the first upload is gone and the other two are whole.
    const files = readdirSync(dir).sort();
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(2);
    const kept = files.filter((f) => f.endsWith(".csv")).map((f) => readFileSync(join(dir, f), "utf8"));
    expect(kept).toEqual([second, third]);
  });

  it("refuses a file that is not an Adjust export and keeps serving the last good one", async () => {
    const res = await upload("hello,world\n1,2");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/has no .*installs/);
    expect(await (await fetch(`${base}/roas-forecast/api/export`)).json()).toMatchObject({ name: "2026-04-01_export.csv" });
  });

  it("refuses uploads in other formats or over the limit", async () => {
    expect((await upload(CSV, { "Content-Type": "text/plain" })).status).toBe(415);
    const big = await upload(CSV + "\n2026-03-03,1,1,0.1,0.1,0.1,0.1".repeat(200));
    expect(big.status).toBe(413);
    expect((await big.json()).error).toMatch(/over/);
  });

  it("keeps only the file's own name", () => {
    expect(fileName(encodeURIComponent("../../etc/" + NAME))).toBe(NAME);
    expect(fileName("C:\\exports\\a.csv")).toBe("a.csv");
    expect(fileName("a\u0000b.csv")).toBe("ab.csv");
    expect(fileName("%E0%A4%A")).toBe("%E0%A4%A");
    expect(fileName(undefined)).toBe("export.csv");
    expect(fileName("../")).toBe("export.csv");
  });
});
