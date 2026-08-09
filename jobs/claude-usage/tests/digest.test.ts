import { describe, expect, it } from "vitest";
import type { Archive } from "../src/archive.js";
import type { DayUsage } from "../src/ccusage.js";
import { compact, formatDigest, shiftDate, sum, window } from "../src/digest.js";

function day(period: string, totalTokens: number, modelsUsed: string[] = ["claude-opus-5"]): DayUsage {
  return {
    period,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    totalTokens,
    totalCost: totalTokens / 1000,
    modelsUsed,
  };
}

function archiveOf(...days: DayUsage[]): Archive {
  return { updatedAt: "t", days: Object.fromEntries(days.map((d) => [d.period, d])) };
}

describe("compact", () => {
  it("scales to K, M and B", () => {
    expect(compact(985)).toBe("985");
    expect(compact(12_300)).toBe("12.3K");
    expect(compact(4_120_000)).toBe("4.1M");
    expect(compact(985_004_038)).toBe("985.0M");
    expect(compact(1_250_000_000)).toBe("1.3B");
  });
});

describe("shiftDate", () => {
  it("crosses month and year boundaries", () => {
    expect(shiftDate("2026-08-09", -6)).toBe("2026-08-03");
    expect(shiftDate("2026-08-02", -6)).toBe("2026-07-27");
    expect(shiftDate("2026-01-03", -6)).toBe("2025-12-28");
  });
});

describe("window", () => {
  it("selects the inclusive range and sorts by date", () => {
    const archive = archiveOf(day("2026-06-03", 3), day("2026-06-01", 1), day("2026-06-05", 5));
    expect(window(archive, "2026-06-01", "2026-06-03").map((d) => d.period)).toEqual([
      "2026-06-01",
      "2026-06-03",
    ]);
  });
});

describe("sum", () => {
  it("totals every token column", () => {
    const totals = sum([day("2026-06-01", 100), day("2026-06-02", 200)]);
    expect(totals).toMatchObject({
      days: 2,
      inputTokens: 20,
      outputTokens: 40,
      cacheCreationTokens: 60,
      cacheReadTokens: 80,
      totalTokens: 300,
    });
  });
});

describe("formatDigest", () => {
  it("reports the window, the busiest day and the archive total", () => {
    const archive = archiveOf(
      day("2026-08-01", 1_000_000), // outside a 7-day window ending 2026-08-09
      day("2026-08-08", 5_000_000, ["claude-opus-5"]),
      day("2026-08-09", 9_000_000, ["claude-fable-5"]),
    );
    const text = formatDigest(archive, "2026-08-09", 7);

    expect(text).toContain("Claude usage — 7 days to 2026-08-09");
    expect(text).toContain("Tokens: 14.0M over 2 active days");
    expect(text).toContain("Busiest: 2026-08-09 (9.0M)");
    expect(text).toContain("Models: fable-5, opus-5"); // ordered by tokens, `claude-` stripped
    expect(text).toContain("Archive: 3 days, 15.0M tokens");
  });

  it("says so plainly when the window is empty", () => {
    const text = formatDigest(archiveOf(day("2026-06-01", 100)), "2026-08-09", 7);
    expect(text).toBe("Claude usage — no activity in the 7 days to 2026-08-09");
  });
});
