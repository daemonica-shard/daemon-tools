import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY, load, merge, save } from "../src/archive.js";
import type { DayUsage } from "../src/ccusage.js";

function day(period: string, totalTokens: number): DayUsage {
  return {
    period,
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    totalTokens,
    totalCost: totalTokens / 1000,
  };
}

describe("merge", () => {
  it("adds days it has not seen before", () => {
    const merged = merge(EMPTY, [day("2026-06-01", 100)], "now");
    expect(Object.keys(merged.days)).toEqual(["2026-06-01"]);
    expect(merged.updatedAt).toBe("now");
  });

  it("replaces a held day when the new reading is larger", () => {
    const held = merge(EMPTY, [day("2026-06-01", 100)], "t1");
    const merged = merge(held, [day("2026-06-01", 250)], "t2");
    expect(merged.days["2026-06-01"].totalTokens).toBe(250);
  });

  // The whole point of the job: a day Claude Code has pruned vanishes from ccusage output, and
  // must survive in the archive regardless.
  it("keeps days that have aged out of the ccusage window", () => {
    const held = merge(EMPTY, [day("2026-06-01", 100), day("2026-06-02", 200)], "t1");
    const merged = merge(held, [day("2026-06-02", 200)], "t2");
    expect(Object.keys(merged.days).sort()).toEqual(["2026-06-01", "2026-06-02"]);
    expect(merged.days["2026-06-01"].totalTokens).toBe(100);
  });

  it("ignores a smaller reading for a day it already holds", () => {
    const held = merge(EMPTY, [day("2026-06-01", 500)], "t1");
    const merged = merge(held, [day("2026-06-01", 10)], "t2");
    expect(merged.days["2026-06-01"].totalTokens).toBe(500);
  });

  it("does not mutate the archive it was given", () => {
    const held = merge(EMPTY, [day("2026-06-01", 100)], "t1");
    merge(held, [day("2026-06-02", 200)], "t2");
    expect(Object.keys(held.days)).toEqual(["2026-06-01"]);
  });
});

describe("load / save", () => {
  it("returns an empty archive when the file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-usage-"));
    expect(await load(join(dir, "missing.json"))).toEqual(EMPTY);
  });

  it("round-trips through disk, creating parent directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-usage-"));
    const path = join(dir, "nested", "archive.json");
    const archive = merge(EMPTY, [day("2026-06-01", 100)], "t1");

    await save(path, archive);
    expect(await load(path)).toEqual(archive);
    expect(await readFile(path, "utf8")).toMatch(/\n$/);
  });
});
