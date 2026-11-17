import { describe, expect, it } from "vitest";
import {
  aggregateCohorts,
  dimensionValues,
  loadAdjustExport,
  parseCsv,
  selectCohorts,
  toDay,
  type AdjustExport,
} from "../src/adjust.js";

// Synthetic export, made up for these tests. Exported 2026-03-31, so cohort days count through 03-29.
//   old    03-01, 03-02, 03-09: weak (D7 ROAS 20%), the only ones old enough for D14
//   new    03-20, 03-21, 03-22: strong (D7 ROAS 40%); their D14 cells are still filling in
//   latest 03-30: nothing finished yet, not even install day
//   organic: no spend
const NAME = "2026-03-31_10_0_adjust_report_export.csv";
const HEADER =
  "day,app,channel,campaign_network,installs,cost,roas_d0,roas_d7,roas_d14,roas_d21,retention_rate_d1,retention_rate_d7,retention_rate_d14";
const ROWS = [
  "2026-03-01,Game,Paid,paid,50,100,0.1,0.2,0.25,0.27,0.3,0.1,0.06",
  "2026-03-02,Game,Paid,paid,50,100,0.1,0.2,0.25,0.27,0.3,0.1,0.06",
  "2026-03-09,Game,Paid,paid,50,100,0.1,0.2,0.25,0.21,0.3,0.1,0.06",
  "2026-03-20,Game,Paid,paid,50,100,0.2,0.4,0.41,0,0.4,0.15,0.02",
  "2026-03-21,Game,Paid,paid,50,100,0.2,0.4,0.41,0,0.4,0.15,0.02",
  "2026-03-22,Game,Paid,paid,50,100,0.2,0.4,0.41,0,0.4,0.15,0.02",
  "2026-03-30,Game,Paid,paid,50,100,0.9,0,0,0,0.05,0,0",
  "2026-03-01,Game,Organic,unknown,20,0,0,0,0,0,0.5,0.2,0.1",
];
const CSV = [HEADER, ...ROWS].join("\n");

function load(text = CSV, name = NAME): AdjustExport {
  const data = loadAdjustExport(text, name);
  if (!data.ok) throw new Error("expected the export to load");
  return data;
}

describe("parseCsv", () => {
  it("handles a byte-order mark, CRLF, quoted commas and doubled quotes", () => {
    expect(parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n\r\n2,z\n')).toEqual({
      columns: ["a", "b"],
      records: [
        { a: "1", b: 'x, "y"' },
        { a: "2", b: "z" },
      ],
    });
  });
});

describe("loadAdjustExport", () => {
  it("finds the segments and the day columns", () => {
    const data = load();
    expect(data.schema.dims).toEqual(["app", "channel", "campaign_network"]);
    expect(data.schema.retention.map((c) => c.day)).toEqual([1, 7, 14]);
    expect(data.schema.roas.map((c) => c.day)).toEqual([0, 7, 14, 21]);
    expect(data.schema.roasKind).toBe("all");
  });

  it("takes the export date from the file name and stops two days before it", () => {
    const data = load();
    expect(data.exportDate).toBe("2026-03-31");
    expect(data.exportDateGuessed).toBe(false);
    expect(data.completeThrough).toBe(toDay("2026-03-29"));
  });

  it("counts cohort days past the last install date when the name dates the export", () => {
    const older = load("day,installs,cost,roas_d0,retention_rate_d1\n2026-03-01,5,10,0.1,0.3");
    expect(older.completeThrough).toBe(toDay("2026-03-29"));
  });

  it("assumes the day after the latest install when the name has no date", () => {
    const data = load(CSV, "report.csv");
    expect(data.exportDateGuessed).toBe(true);
    expect(data.exportDate).toBe("2026-03-31");
    expect(data.completeThrough).toBe(toDay("2026-03-29"));
  });

  it("names the columns it can't do without", () => {
    const r = loadAdjustExport("day,installs\n2026-01-01,5", "x.csv");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.schema.missing).toEqual(["retention_rate_dN"]);
  });

  it("falls back to ad-only ROAS, and drops ROAS when there is no spend column", () => {
    const adOnly = load("day,installs,cost,roas_ad_d0,retention_rate_d1\n2026-01-01,5,10,0.1,0.3", "x.csv");
    expect(adOnly.schema.roasKind).toBe("ad");
    expect(adOnly.schema.roas.map((c) => c.col)).toEqual(["roas_ad_d0"]);
    const noCost = load("day,installs,roas_d0,retention_rate_d1\n2026-01-01,5,0.1,0.3", "x.csv");
    expect(noCost.schema.roas).toEqual([]);
  });
});

describe("aggregateCohorts", () => {
  const curve = aggregateCohorts(load(), { dims: { campaign_network: "paid" } });

  it("chains later days on the cohorts that finished both, so the cohort mix can't bend the curve", () => {
    // A per-day average would put D14 ROAS at 25% (old cohorts only) under a 30% D7.
    const roas = curve.roas.map((p) => [p.day, p.value]);
    expect(roas.map(([d]) => d)).toEqual([0, 7, 14]);
    expect(roas[0][1]).toBeCloseTo(0.15, 12);
    expect(roas[1][1]).toBeCloseTo(0.3, 12);
    expect(roas[2][1]).toBeCloseTo(0.375, 12);
    const ret = curve.retention.map((p) => [p.day, p.value]);
    expect(ret.map(([d]) => d)).toEqual([1, 7, 14]);
    expect(ret[0][1]).toBeCloseTo(0.35, 12);
    expect(ret[1][1]).toBeCloseTo(0.125, 12);
    expect(ret[2][1]).toBeCloseTo(0.075, 12);
  });

  it("leaves out cells that are still filling in", () => {
    // 03-30's install day and the new cohorts' D14 never enter.
    expect(curve.roas[0].cohorts).toBe(6);
    expect(curve.roas[2].cohorts).toBe(3);
  });

  it("stops at the first day with too few finished cohorts and says why", () => {
    expect(curve.skipped.roas).toEqual({ day: 21, cohorts: 2, share: 200 / 700 });
    expect(curve.skipped.retention).toBeNull();
  });

  it("summarises the selection, CPI over paid installs and over all of them", () => {
    expect(curve.summary).toMatchObject({ rows: 7, cohortDays: 7, installs: 350, unpaidInstalls: 0, cost: 700, cpi: 2, blendedCpi: 2 });
    const all = aggregateCohorts(load());
    expect(all.summary).toMatchObject({ installs: 370, unpaidInstalls: 20, cost: 700, cpi: 2 });
    expect(all.summary.blendedCpi).toBeCloseTo(700 / 370, 12);
  });

  it("counts install days, not rows, toward the 3-cohort minimum", () => {
    // Two segments on 03-01 and on 03-02 finish D7: four rows, but two install days.
    const text = [
      "day,channel,installs,cost,roas_d0,roas_d7,retention_rate_d1,retention_rate_d7",
      "2026-03-01,A,50,100,0.1,0.2,0.3,0.1",
      "2026-03-01,B,50,100,0.1,0.2,0.3,0.1",
      "2026-03-02,A,50,100,0.1,0.2,0.3,0.1",
      "2026-03-02,B,50,100,0.1,0.2,0.3,0.1",
      "2026-03-25,A,50,100,0.1,0,0.3,0",
    ].join("\n");
    const two = aggregateCohorts(load(text));
    expect(two.roas.map((p) => [p.day, p.cohorts])).toEqual([[0, 3]]);
    expect(two.skipped.roas).toEqual({ day: 7, cohorts: 2, share: 0.8 });
    expect(two.skipped.retention).toEqual({ day: 7, cohorts: 2, share: 0.8 });
  });

  it("filters by install date", () => {
    const early = aggregateCohorts(load(), { dims: { campaign_network: "paid" }, from: toDay("2026-03-01"), to: toDay("2026-03-09") });
    expect(early.summary.rows).toBe(3);
    expect(early.roas[0].value).toBeCloseTo(0.1, 12);
  });
});

describe("dimensionValues", () => {
  it("lists values by spend and respects the other filters", () => {
    const data = load();
    expect(dimensionValues(data, "channel").map((v) => [v.value, v.cost])).toEqual([
      ["Paid", 700],
      ["Organic", 0],
    ]);
    expect(dimensionValues(data, "campaign_network", { dims: { channel: "Organic" } }).map((v) => v.value)).toEqual(["unknown"]);
  });
});

describe("installs without spend", () => {
  // The same export with revenue by event date: every paid row earned 30, the organic row 21.
  const WITH_EVENTS = [HEADER + ",all_revenue", ...ROWS.map((r) => r + (r.includes(",Organic,") ? ",21" : ",30"))].join("\n");

  it("raises ROAS by what they earned by event date, as a share of what paid installs earned", () => {
    const all = aggregateCohorts(load(WITH_EVENTS));
    expect(all.unpaid).toEqual({ installs: 20, revenue: "estimated", eventRevenue: 21, paidEventRevenue: 210, uplift: 0.1 });
    expect(all.roas.map((p) => p.value)).toEqual([0.15, 0.3, 0.375].map((v) => expect.closeTo(v * 1.1, 12)));
  });

  it("counts every install toward retention, one cohort per install day", () => {
    // 03-01 holds a paid row and the organic one: one cohort of 70 installs.
    const all = aggregateCohorts(load(WITH_EVENTS));
    expect(all.retention[0].cohorts).toBe(6);
    expect(all.retention[0].value).toBeCloseTo(115 / 320, 12);
  });

  it("leaves them out on request", () => {
    const paid = aggregateCohorts(load(WITH_EVENTS), { spend: "paid" });
    expect(paid.unpaid.revenue).toBe("none");
    expect(paid.summary).toMatchObject({ installs: 350, unpaidInstalls: 0 });
    expect(paid.roas[0].value).toBeCloseTo(0.15, 12);
    expect(paid.retention[0].value).toBeCloseTo(105 / 300, 12);
    expect(selectCohorts(load(WITH_EVENTS), { spend: "unpaid" }).map((c) => c.dims.channel)).toEqual(["Organic"]);
  });

  it("says so when the export has no revenue for them", () => {
    const all = aggregateCohorts(load());
    expect(all.unpaid).toMatchObject({ installs: 20, revenue: "missing", uplift: 0 });
    expect(all.roas[0].value).toBeCloseTo(0.15, 12);
  });

  it("counts their revenue as it is when the export has cohort revenue", () => {
    // Paid: 10 by D0 and 20 by D7 on 100 of spend. Organic: 3 by D0, 6 by D7, no spend.
    const text = [
      "day,channel,installs,cost,roas_d0,roas_d7,ad_revenue_total_d0,revenue_total_d0,ad_revenue_total_d7,revenue_total_d7,retention_rate_d1,retention_rate_d7",
      "2026-03-01,Paid,50,100,0.1,0.2,9,1,18,2,0.3,0.1",
      "2026-03-02,Paid,50,100,0.1,0.2,9,1,18,2,0.3,0.1",
      "2026-03-03,Paid,50,100,0.1,0.2,9,1,18,2,0.3,0.1",
      "2026-03-01,Organic,20,0,0,0,3,0,6,0,0.5,0.2",
    ].join("\n");
    const data = load(text);
    expect(data.schema.cohortRevenue).toEqual([
      { day: 0, cols: ["ad_revenue_total_d0", "revenue_total_d0"] },
      { day: 7, cols: ["ad_revenue_total_d7", "revenue_total_d7"] },
    ]);
    const all = aggregateCohorts(data);
    expect(all.unpaid).toMatchObject({ installs: 20, revenue: "counted", uplift: 0 });
    expect(all.roas.map((p) => p.value)).toEqual([expect.closeTo(33 / 300, 12), expect.closeTo(66 / 300, 12)]);
    const paid = aggregateCohorts(data, { spend: "paid" });
    expect(paid.roas.map((p) => p.value)).toEqual([expect.closeTo(0.1, 12), expect.closeTo(0.2, 12)]);
  });

  it("reads cohort revenue only when it covers every ROAS day, and never in-app revenue alone", () => {
    const partial = load("day,installs,cost,roas_d0,roas_d7,ad_revenue_total_d0,revenue_total_d0,retention_rate_d1\n2026-03-01,5,10,0.1,0.2,1,0,0.3");
    expect(partial.schema.cohortRevenue).toEqual([]);
    const inApp = load("day,installs,cost,roas_d0,revenue_total_d0,retention_rate_d1\n2026-03-01,5,10,0.1,0,0.3");
    expect(inApp.schema.cohortRevenue).toEqual([]);
    const all = load("day,installs,cost,roas_d0,all_revenue_total_d0,retention_rate_d1\n2026-03-01,5,10,0.1,1,0.3");
    expect(all.schema.cohortRevenue).toEqual([{ day: 0, cols: ["all_revenue_total_d0"] }]);
  });

  it("sizes the estimate with revenue of the same kind as ROAS", () => {
    const cols = (header: string, row: string) => load(`${header}\n${row}`).schema.eventRevenue;
    expect(cols("day,installs,cost,roas_d0,all_revenue,ad_revenue,revenue,retention_rate_d1", "2026-03-01,5,10,0.1,3,2,1,0.3")).toEqual(["all_revenue"]);
    expect(cols("day,installs,cost,roas_d0,ad_revenue,revenue,retention_rate_d1", "2026-03-01,5,10,0.1,2,1,0.3")).toEqual(["ad_revenue", "revenue"]);
    expect(cols("day,installs,cost,roas_d0,ad_revenue,retention_rate_d1", "2026-03-01,5,10,0.1,2,0.3")).toEqual([]);
    expect(cols("day,installs,cost,roas_ad_d0,ad_revenue,all_revenue,retention_rate_d1", "2026-03-01,5,10,0.1,2,3,0.3")).toEqual(["ad_revenue"]);
  });

  it("adds revenue by event date to segment values", () => {
    expect(dimensionValues(load(WITH_EVENTS), "channel").map((v) => [v.value, v.eventRevenue])).toEqual([
      ["Paid", 210],
      ["Organic", 21],
    ]);
  });
});
