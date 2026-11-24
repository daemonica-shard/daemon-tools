import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReportRequest } from "@daemon-tools/applovin";
import { byDay, days, records, sync, type Manifest } from "../src/sync.js";

const HEADER = "Day,Campaign,Country,Conversions,Cost";

/** Answers each request with one row per day of its range, except the days in `quiet`. */
function fakeReporting(quiet: string[] = []) {
  const requests: ReportRequest[] = [];
  return {
    requests,
    report: async (req: ReportRequest) => {
      requests.push(req);
      const rows = days(req.start, req.end)
        .filter((day) => !quiet.includes(day))
        .map((day) => `${day},"Game_And, D7",us,3,$4.50`);
      return `${[HEADER, ...rows].join("\n")}\n`;
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "applovin-spend-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parsing", () => {
  it("splits records without breaking quoted line breaks or commas", () => {
    expect(records('Day,Campaign\r\n2026-11-01,"two\nlines, and a comma"\n\n2026-11-02,b')).toEqual([
      "Day,Campaign",
      '2026-11-01,"two\nlines, and a comma"',
      "2026-11-02,b",
    ]);
  });

  it("groups rows by their leading day and refuses anything else", () => {
    const { header, rows } = byDay(`${HEADER}\n2026-11-01,a,us,1,$1\n2026-11-02,b,iq,2,$2\n2026-11-01,c,de,3,$3\n`);
    expect(header).toBe(HEADER);
    expect([...rows.entries()]).toEqual([
      ["2026-11-01", ["2026-11-01,a,us,1,$1", "2026-11-01,c,de,3,$3"]],
      ["2026-11-02", ["2026-11-02,b,iq,2,$2"]],
    ]);
    expect(() => byDay("Campaign,Day\nx,2026-11-01\n")).toThrow(/Day column/);
    expect(() => byDay(`${HEADER}\n11/01/2026,a,us,1,$1\n`)).toThrow(/Unexpected row/);
  });
});

describe("sync", () => {
  it("covers the range in month-long requests and writes a file per day, empty days included", async () => {
    const reporting = fakeReporting(["2026-10-15"]);
    const result = await sync({ reporting, dir, since: "2026-10-11", until: "2026-11-24", now: () => Date.parse("2026-11-24T12:00:00Z") });

    expect(reporting.requests.map((r) => `${r.start}..${r.end}`)).toEqual(["2026-10-11..2026-11-09", "2026-11-10..2026-11-24"]);
    expect(reporting.requests[0]).toMatchObject({ reportType: "advertiser" });
    expect(reporting.requests[0].columns[0]).toBe("day");
    expect(result).toEqual({ days: 45, rows: 44 });
    expect(await readFile(join(dir, "2026-11-01.csv"), "utf8")).toBe(`${HEADER}\n2026-11-01,"Game_And, D7",us,3,$4.50\n`);
    expect(await readFile(join(dir, "2026-10-15.csv"), "utf8")).toBe(`${HEADER}\n`);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest["2026-10-15"]).toEqual({ rows: 0, fetchedAt: "2026-11-24T12:00:00.000Z" });
    expect((await readdir(dir)).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  // AppLovin revises recent days, and drops days older than 45: a later run must refresh what it
  // fetched and leave the rest of the history alone.
  it("overwrites the days it fetches and keeps older ones", async () => {
    await sync({ reporting: fakeReporting(), dir, since: "2026-11-01", until: "2026-11-03", now: () => 1 });
    await sync({ reporting: fakeReporting(["2026-11-03"]), dir, since: "2026-11-02", until: "2026-11-03", now: () => 2 });
    expect(await readFile(join(dir, "2026-11-03.csv"), "utf8")).toBe(`${HEADER}\n`);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(Object.keys(manifest)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(manifest["2026-11-01"].fetchedAt).toBe(new Date(1).toISOString());
    expect(manifest["2026-11-03"]).toEqual({ rows: 0, fetchedAt: new Date(2).toISOString() });
  });

  it("refuses rows for days it didn't ask for", async () => {
    const reporting = { report: async () => `${HEADER}\n2026-10-01,a,us,1,$1\n` };
    await expect(sync({ reporting, dir, since: "2026-11-01", until: "2026-11-01" })).rejects.toThrow(/outside 2026-11-01..2026-11-01: 2026-10-01/);
  });
});
