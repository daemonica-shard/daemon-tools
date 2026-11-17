import { describe, expect, it } from "vitest";
import { forecast, type Forecast, type ForecastResult } from "../src/model.js";

function ok(r: ForecastResult): Forecast {
  if (!r.ok) throw new Error("expected a forecast");
  return r;
}

// The textbook case: D1 40%, D7 15%, D7 ROAS 20%, nothing else.
const TEXTBOOK = {
  retention: [
    { day: 1, value: 0.4 },
    { day: 7, value: 0.15 },
  ],
  roas: [{ day: 7, value: 0.2 }],
};

// Revenue per active player falls with age: 7.2% → 6.2% → 4.7% of CPI per day across the windows.
const FALLING = {
  retention: [
    { day: 1, value: 0.35 },
    { day: 3, value: 0.22 },
    { day: 7, value: 0.14 },
    { day: 14, value: 0.09 },
  ],
  roas: [
    { day: 0, value: 0.1 },
    { day: 3, value: 0.16 },
    { day: 7, value: 0.2 },
    { day: 14, value: 0.235 },
  ],
};

describe("forecast", () => {
  it("reduces to ROAS(n) · LT(N) / LT(n) with one ROAS reading and flat revenue", () => {
    const f = ok(forecast(TEXTBOOK, { driftMode: "flat" }));
    expect(f.tail.b).toBeCloseTo(Math.log(0.4 / 0.15) / Math.log(7), 10);
    // 1 + 0.4 · Σ d^-0.504 for d = 1…7, worked by hand
    expect(f.base.LT[7]).toBeCloseTo(2.6008, 3);
    for (const N of [14, 30, 90, 365, 730]) {
      expect(f.base.roas[N]).toBeCloseTo((0.2 * f.base.LT[N]) / f.base.LT[7], 10);
    }
    expect(f.base.roas[365]).toBeCloseTo(1.19, 2);
    expect(f.base.payback).toBeGreaterThan(245);
    expect(f.base.payback).toBeLessThan(265);
  });

  it("reproduces every measured ROAS point", () => {
    const f = ok(forecast(FALLING));
    for (const p of f.roas) expect(f.base.roas[p.day]).toBeCloseTo(p.value, 12);
  });

  it("asks for what is missing", () => {
    expect(forecast({ retention: [{ day: 1, value: 0.4 }], roas: [] })).toEqual({
      ok: false,
      needRetention: true,
      needRoas: true,
    });
    expect(forecast({ retention: TEXTBOOK.retention, roas: [] })).toEqual({
      ok: false,
      needRetention: false,
      needRoas: true,
    });
  });

  it("ignores points outside the valid days and values", () => {
    const f = ok(
      forecast({
        retention: [
          { day: 0, value: 1 },
          { day: 1, value: 0.4 },
          { day: 7, value: 1.5 },
          { day: 7, value: 0.15 },
          { day: Number.NaN, value: 0.1 },
        ],
        roas: [
          { day: -1, value: 0.1 },
          { day: 7, value: 0.2 },
        ],
      }),
    );
    expect(f.retention).toEqual(TEXTBOOK.retention);
    expect(f.roas).toEqual(TEXTBOOK.roas);
  });

  it("keeps the range around the base forecast, closed inside the data", () => {
    const f = ok(forecast(FALLING));
    for (let d = 0; d <= f.options.maxDay; d++) {
      expect(f.band.roasLow[d]).toBeLessThanOrEqual(f.base.roas[d] + 1e-12);
      expect(f.band.roasHigh[d]).toBeGreaterThanOrEqual(f.base.roas[d] - 1e-12);
    }
    expect(f.band.roasHigh[f.lastRoasDay]).toBeCloseTo(f.band.roasLow[f.lastRoasDay], 12);
    expect(f.band.roasHigh[365]).toBeGreaterThan(f.band.roasLow[365]);
  });

  it("measures a falling revenue trend and ranks the paths: throughout < until D30 < flat", () => {
    const flat = ok(forecast(FALLING, { driftMode: "flat" }));
    const t30 = ok(forecast(FALLING, { driftMode: "trend30" }));
    const trend = ok(forecast(FALLING, { driftMode: "trend" }));
    expect(flat.drift!.perDoubling).toBeLessThan(0);
    expect(ok(forecast(FALLING)).mode).toBe("trend30");
    expect(trend.base.roas[365]).toBeLessThan(t30.base.roas[365]);
    expect(t30.base.roas[365]).toBeLessThan(flat.base.roas[365]);
    // "until D30, then hold": revenue per active player stops changing at D30
    expect(t30.base.u[200]).toBe(t30.base.u[30]);
    expect(t30.base.u[30]).toBeLessThan(t30.base.u[15]);
  });

  it("falls back to flat when no trend can be measured", () => {
    const f = ok(forecast(TEXTBOOK, { driftMode: "trend" }));
    expect(f.drift).toBeNull();
    expect(f.mode).toBe("flat");
  });

  it("applies a custom change per doubling of player age", () => {
    const flat = ok(forecast(TEXTBOOK, { driftMode: "flat" }));
    const up = ok(forecast(TEXTBOOK, { driftMode: "custom", driftCustom: 0.1 }));
    const w = up.base.windows[up.base.windows.length - 1];
    expect(up.base.u[100]).toBeCloseTo(w.u * Math.pow(101 / (w.meanAge + 1), Math.log2(1.1)), 12);
    expect(up.base.roas[365]).toBeGreaterThan(flat.base.roas[365]);
  });

  it("flags retention that rises and ROAS that falls", () => {
    const f = ok(
      forecast({
        retention: [
          { day: 1, value: 0.3 },
          { day: 3, value: 0.32 },
          { day: 7, value: 0.2 },
        ],
        roas: [
          { day: 3, value: 0.2 },
          { day: 7, value: 0.18 },
        ],
      }),
    );
    const notes = f.notes.map((n) => n.text).join("\n");
    expect(notes).toMatch(/Retention rises from D1 to D3/);
    expect(notes).toMatch(/ROAS falls from D3 to D7/);
    expect(f.base.windows[1].u).toBe(0);
  });

  it("holds out the last ROAS and retention points as checks", () => {
    const f = ok(forecast(FALLING, { driftMode: "flat" }));
    expect(f.checks.roas).toMatchObject({ fromDay: 7, day: 14, actual: 0.235 });
    expect(f.checks.retention).toMatchObject({ toDay: 7, day: 14, actual: 0.09 });
    // Flat revenue from the D4–D7 window overshoots a cohort whose revenue per player keeps falling.
    expect(f.checks.roas!.predicted).toBeGreaterThan(0.235);
  });
});
