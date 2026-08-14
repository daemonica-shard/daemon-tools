import { describe, expect, it } from "vitest";
import type { Archive } from "../src/archive.js";
import type { DayUsage } from "../src/ccusage.js";
import { localDate, payload, select } from "../src/publish.js";

function day(period: string, outputTokens: number, cost: number): DayUsage {
  return {
    period,
    inputTokens: 10,
    outputTokens,
    cacheCreationTokens: 20,
    cacheReadTokens: 30,
    totalTokens: outputTokens + 60,
    totalCost: cost,
    modelBreakdowns: [
      { modelName: "claude-opus-5", inputTokens: 10, outputTokens, cacheCreationTokens: 20, cacheReadTokens: 30, cost },
    ],
  };
}

function archive(...periods: string[]): Archive {
  const days: Record<string, DayUsage> = {};
  for (const p of periods) days[p] = day(p, 100, 1.5);
  return { updatedAt: "t", days };
}

const OPTS = { today: "2026-08-15", windowDays: 7, firstRun: false };

describe("select", () => {
  it("publishes finished days it has not sent yet", () => {
    const s = select(archive("2026-08-12", "2026-08-13", "2026-08-14"), new Set(["2026-08-12"]), OPTS);
    expect(s.publish).toEqual(["2026-08-13", "2026-08-14"]);
  });

  // Today's total is still growing, and a day may only ever be sent once: the dashboard's stat
  // panels sum_over_time() every sample in range, so a second sample double-counts that day.
  it("never publishes today", () => {
    const s = select(archive("2026-08-14", "2026-08-15"), new Set(), OPTS);
    expect(s.publish).toEqual(["2026-08-14"]);
  });

  it("does not re-publish a day already sent", () => {
    const s = select(archive("2026-08-14"), new Set(["2026-08-14"]), OPTS);
    expect(s.publish).toEqual([]);
  });

  // Prometheus rejects samples past its out-of-order window and one bad point fails the batch, so
  // these are reported rather than sent — they need the promtool block import instead.
  it("reports days older than the out-of-order window instead of sending them", () => {
    const s = select(archive("2026-07-01", "2026-08-14"), new Set(["2026-06-01"]), OPTS);
    expect(s.publish).toEqual(["2026-08-14"]);
    expect(s.tooOld).toEqual(["2026-07-01"]);
  });

  // A laptop asleep for a fortnight is the case this exists for: the gap is real and permanent, so
  // it must be named — but only once, or every later run repeats news already acted on.
  it("writes an aged-out day off so it is reported once, not nightly", () => {
    const days = archive("2026-07-01", "2026-08-14");
    const first = select(days, new Set(["2026-06-01"]), OPTS);
    expect(first.tooOld).toEqual(["2026-07-01"]);

    const handled = new Set(["2026-06-01", ...first.publish, ...first.tooOld]);
    expect(select(days, handled, OPTS).tooOld).toEqual([]);
  });

  // The days before this are already in Prometheus from the promtool import, at these very
  // timestamps. Re-sending them is a duplicate-sample error that fails the whole batch.
  it("sends only yesterday on a first run, and writes off the promtool era silently", () => {
    const s = select(archive("2026-08-10", "2026-08-11", "2026-08-14"), new Set(), { ...OPTS, firstRun: true });
    expect(s.publish).toEqual(["2026-08-14"]);
    expect(s.tooOld).toEqual([]);
    expect(s.seed).toEqual(["2026-08-10", "2026-08-11"]);
  });

  it("honours an explicit catch-up floor", () => {
    const s = select(archive("2026-08-10", "2026-08-12", "2026-08-14"), new Set(), {
      ...OPTS,
      firstRun: true,
      since: "2026-08-12",
    });
    expect(s.publish).toEqual(["2026-08-12", "2026-08-14"]);
    expect(s.seed).toEqual(["2026-08-10"]);
  });
});

describe("localDate", () => {
  // The bug this exists for: ccusage keys days by local date, so a UTC "today" is a whole day off
  // east of Greenwich. The job fires at 03:10 local, which is still yesterday in UTC — so every
  // finished day looked unfinished and waited an extra cycle.
  it("reads the local calendar day, not the UTC one", () => {
    // 2026-08-15 00:45 in UTC+4 — still 2026-08-14 in UTC.
    const atMidnightish = new Date(2026, 7, 15, 0, 45, 0);
    expect(localDate(atMidnightish)).toBe("2026-08-15");
  });

  it("pads single-digit months and days", () => {
    expect(localDate(new Date(2026, 0, 5, 12, 0, 0))).toBe("2026-01-05");
  });
});

interface Emitted {
  resourceMetrics: {
    resource: { attributes: { key: string; value: { stringValue: string } }[] };
    scopeMetrics: {
      metrics: {
        name: string;
        gauge: { dataPoints: { timeUnixNano: string; asDouble: number; attributes: { key: string; value: { stringValue: string } }[] }[] };
      }[];
    }[];
  }[];
}

function emit(days: string[]): Emitted {
  return payload(archive(...days), days, "test-host") as Emitted;
}

function metric(p: Emitted, name: string) {
  const found = p.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === name);
  if (!found) throw new Error(`no metric ${name}`);
  return found;
}

describe("payload", () => {
  // The names and labels must match the promtool import exactly, or the panels get a seam on the
  // day this job took over from the manual backfill.
  it("emits the archive's own metric names", () => {
    const names = emit(["2026-08-14"]).resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name);
    expect(names).toEqual(["claude_usage_archive_daily_tokens", "claude_usage_archive_daily_cost_USD"]);
  });

  it("stamps a day at its own midnight UTC, in nanoseconds", () => {
    const point = metric(emit(["2026-08-14"]), "claude_usage_archive_daily_cost_USD").gauge.dataPoints[0];
    expect(point.timeUnixNano).toBe(`${Date.parse("2026-08-14T00:00:00Z")}000000`);
    // A JSON number cannot hold a nanosecond timestamp exactly; proto3 maps uint64 to a string.
    expect(typeof point.timeUnixNano).toBe("string");
  });

  it("splits tokens by type and labels them by model", () => {
    const points = metric(emit(["2026-08-14"]), "claude_usage_archive_daily_tokens").gauge.dataPoints;
    const byType = Object.fromEntries(
      points.map((p) => [p.attributes.find((a) => a.key === "type")?.value.stringValue, p.asDouble]),
    );
    expect(byType).toEqual({ input: 10, output: 100, cacheCreation: 20, cacheRead: 30 });
    expect(points.every((p) => p.attributes.some((a) => a.key === "model" && a.value.stringValue === "claude-opus-5"))).toBe(true);
  });

  // The archive is per-machine; a second Mac must land on its own series rather than overwrite
  // this one's samples at identical timestamps.
  it("carries the hostname as the instance", () => {
    const attributes = emit(["2026-08-14"]).resourceMetrics[0].resource.attributes;
    expect(attributes).toContainEqual({ key: "service.instance.id", value: { stringValue: "test-host" } });
  });
});
