// Cohort ROAS forecast from early retention and early ROAS.
//
//   ROAS(N) = Σ R(d) · u(d)  for d = 0 … N
//   R(d)  share of installs that play on day d; R(0) = 1 (install day)
//   u(d)  revenue per active player on day d, as a share of CPI (ARPDAU ÷ CPI)
//
// R comes from the retention points: log-log interpolation inside the data, then a power-law tail
// R(L)·(d/L)^-b past the last point L, with b fitted on the last two doublings of age. u comes from
// the ROAS points: each step between two readings divided by the days played inside it. Past the
// last reading, u starts from the newest window and follows the chosen path. With one ROAS reading
// and a flat path this reduces to the textbook ROAS(N) = ROAS(n) · LT(N) ÷ LT(n), where LT is
// cumulative retention: CPI cancels, so the forecast needs neither spend nor install counts.

export interface Point {
  day: number;
  value: number;
}

export type DriftMode = "auto" | "flat" | "trend30" | "trend" | "custom";
export type ResolvedDriftMode = Exclude<DriftMode, "auto">;

export interface ForecastOptions {
  /** Last day projected. */
  maxDay?: number;
  /** Break-even ROAS: 1 = 100%. */
  target?: number;
  /**
   * What revenue per active player does after the last ROAS reading: hold flat, follow the
   * measured trend until `trendStop` then hold, follow it throughout, or a custom % per doubling
   * of player age. "auto" picks trend30 when a trend is measurable, else flat.
   */
  driftMode?: DriftMode;
  /** Change per doubling of player age for "custom", as a fraction: -0.1 = -10%. */
  driftCustom?: number;
  /** ± on the retention tail exponent, for the range. */
  tailSpread?: number;
  /** ± on the chosen drift (fraction per doubling of age), for the range. */
  driftSpread?: number;
  /** Day where "trend30" stops changing. */
  trendStop?: number;
  /** Floor for the tail exponent, so the tail always decays. */
  minTailExp?: number;
}

export const DEFAULTS: Required<ForecastOptions> = {
  maxDay: 730,
  target: 1,
  driftMode: "auto",
  driftCustom: 0,
  tailSpread: 0.1,
  driftSpread: 0.05,
  trendStop: 30,
  minTailExp: 0.05,
};

export interface RoasWindow {
  start: number;
  end: number;
  /** Days played inside the window, per install. */
  active: number;
  /** Activity-weighted mean age of the window. */
  meanAge: number;
  /** ROAS gained across the window. */
  gained: number;
  /** Revenue per active player per day, as a share of CPI. */
  u: number;
}

export interface Drift {
  /** Measured change in revenue per active player per doubling of age, capped to ±50%. */
  perDoubling: number;
  raw: number;
  windows: number;
  from: number;
  to: number;
}

export interface Tail {
  b: number;
  from: number;
  to: number;
  points: number;
}

export interface Path {
  p: number;
  stop: number;
}

export interface Curves {
  /** Retention by day. */
  R: Float64Array;
  /** Cumulative days played per install by day, install day included. */
  LT: Float64Array;
  windows: RoasWindow[];
  /** Revenue per active player by day, as a share of CPI. */
  u: Float64Array;
  /** Cumulative ROAS by day. */
  roas: Float64Array;
}

export interface Band {
  roasLow: Float64Array;
  roasHigh: Float64Array;
  retLow: Float64Array;
  retHigh: Float64Array;
  uLow: Float64Array;
  uHigh: Float64Array;
  /** Slowest payback in the range; null when it never reaches the target within maxDay. */
  paybackLow: number | null;
  /** Fastest payback in the range. */
  paybackHigh: number | null;
}

export interface Note {
  level: "warn" | "info";
  text: string;
}

export interface Forecast {
  ok: true;
  options: Required<ForecastOptions>;
  retention: Point[];
  roas: Point[];
  lastRoasDay: number;
  lastRoasValue: number;
  lastRetentionDay: number;
  tail: Tail;
  powerFit: { a: number; b: number; r2: number | null };
  drift: Drift | null;
  mode: ResolvedDriftMode;
  path: Path;
  base: Curves & { payback: number | null };
  band: Band;
  /** Hold-outs: the last point predicted from the ones before it. */
  checks: {
    roas?: { fromDay: number; day: number; predicted: number; actual: number };
    retention?: { toDay: number; day: number; predicted: number; actual: number };
  };
  notes: Note[];
}

export interface MissingData {
  ok: false;
  needRetention: boolean;
  needRoas: boolean;
}

export type ForecastResult = Forecast | MissingData;

export interface ForecastInput {
  /** Day-N retention as a fraction, days >= 1. */
  retention: ReadonlyArray<Point>;
  /** Cumulative ROAS through day N as a fraction, days >= 0. */
  roas: ReadonlyArray<Point>;
}

interface Fit {
  slope: number;
  intercept: number;
  r2: number | null;
}

function ols(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return {
    slope,
    intercept: my - slope * mx,
    r2: n > 2 && sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : null,
  };
}

function clean(
  points: ReadonlyArray<Point> | undefined,
  minDay: number,
  maxDay: number,
  valid: (v: number) => boolean,
): Point[] {
  const byDay = new Map<number, number>();
  for (const p of points ?? []) {
    if (!p) continue;
    const day = Math.round(Number(p.day));
    const value = Number(p.value);
    if (!Number.isFinite(day) || !Number.isFinite(value)) continue;
    if (day < minDay || day > maxDay || !valid(value)) continue;
    byDay.set(day, value);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, value]) => ({ day, value }));
}

// Decay over the last two doublings of age, using at least three points when there are three.
// The early days (onboarding churn) decay differently from the tail, so they shouldn't set it.
function tailExponent(points: Point[]): Tail {
  const L = points[points.length - 1].day;
  let tail = points.filter((p) => p.day >= L / 4);
  if (tail.length < 3) tail = points.slice(-Math.min(3, points.length));
  const f = ols(
    tail.map((p) => Math.log(p.day)),
    tail.map((p) => Math.log(p.value)),
  );
  return { b: -f.slope, from: tail[0].day, to: tail[tail.length - 1].day, points: tail.length };
}

function retentionCurve(points: Point[], b: number, maxDay: number): Float64Array {
  const R = new Float64Array(maxDay + 1);
  R[0] = 1;
  const n = points.length;
  const xs = points.map((p) => Math.log(p.day));
  const ys = points.map((p) => Math.log(p.value));
  const first = points[0];
  const last = points[n - 1];
  const headSlope = (ys[1] - ys[0]) / (xs[1] - xs[0]);
  let seg = 0;
  for (let d = 1; d <= maxDay; d++) {
    let v: number;
    if (d < first.day) {
      v = Math.exp(ys[0] + headSlope * (Math.log(d) - xs[0]));
    } else if (d <= last.day) {
      while (seg < n - 2 && d > points[seg + 1].day) seg++;
      const t = (Math.log(d) - xs[seg]) / (xs[seg + 1] - xs[seg]);
      v = Math.exp(ys[seg] + t * (ys[seg + 1] - ys[seg]));
    } else {
      v = last.value * Math.pow(d / last.day, -b);
    }
    R[d] = Math.min(1, v);
  }
  return R;
}

function cumulative(arr: Float64Array): Float64Array {
  const out = new Float64Array(arr.length);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    out[i] = s;
  }
  return out;
}

function roasWindows(roas: Point[], R: Float64Array): RoasWindow[] {
  const out: RoasWindow[] = [];
  let prevDay = -1;
  let prevVal = 0;
  for (const p of roas) {
    let A = 0;
    let M = 0;
    for (let d = prevDay + 1; d <= p.day; d++) {
      A += R[d];
      M += d * R[d];
    }
    const gained = p.value - prevVal;
    out.push({
      start: prevDay + 1,
      end: p.day,
      active: A,
      meanAge: A > 0 ? M / A : (prevDay + 1 + p.day) / 2,
      gained,
      u: A > 0 ? Math.max(gained, 0) / A : 0,
    });
    prevDay = p.day;
    prevVal = p.value;
  }
  return out;
}

// Trend of revenue per active day across the windows after install day. Install day is left out:
// first sessions earn differently (long sessions for ads, starter packs for purchases).
function fitDrift(wins: RoasWindow[]): Drift | null {
  const use = wins.filter((w) => w.start >= 1 && w.u > 0);
  if (use.length < 2) return null;
  const f = ols(
    use.map((w) => Math.log(w.meanAge + 1)),
    use.map((w) => Math.log(w.u)),
  );
  const raw = Math.pow(2, f.slope) - 1;
  return {
    perDoubling: Math.max(-0.5, Math.min(0.5, raw)),
    raw,
    windows: use.length,
    from: use[0].start,
    to: use[use.length - 1].end,
  };
}

// u(d) for every day: the measured windows, then the path past the last ROAS day.
function revenuePerActiveDay(wins: RoasWindow[], path: Path, maxDay: number): Float64Array {
  const g = Math.log(1 + Math.max(path.p, -0.9)) / Math.LN2;
  const lastWin = wins[wins.length - 1];
  const lastDay = lastWin.end;
  const u = new Float64Array(maxDay + 1);
  let wi = 0;
  for (let d = 0; d <= maxDay; d++) {
    if (d <= lastDay) {
      while (d > wins[wi].end) wi++;
      u[d] = wins[wi].u;
    } else {
      const age = Math.min(d, Math.max(path.stop, lastDay));
      u[d] = lastWin.u * Math.pow((age + 1) / (lastWin.meanAge + 1), g);
    }
  }
  return u;
}

function firstReach(cum: Float64Array, target: number): number | null {
  for (let d = 0; d < cum.length; d++) if (cum[d] >= target) return d;
  return null;
}

function run(ret: Point[], roas: Point[], b: number, path: Path, o: Required<ForecastOptions>): Curves {
  const R = retentionCurve(ret, Math.max(b, o.minTailExp), o.maxDay);
  const windows = roasWindows(roas, R);
  const u = revenuePerActiveDay(windows, path, o.maxDay);
  const daily = new Float64Array(o.maxDay + 1);
  for (let d = 0; d <= o.maxDay; d++) daily[d] = R[d] * u[d];
  return { R, LT: cumulative(R), windows, u, roas: cumulative(daily) };
}

function minMax(arrays: Float64Array[]): { lo: Float64Array; hi: Float64Array } {
  const n = arrays[0].length;
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let d = 0; d < n; d++) {
    let a = Infinity;
    let z = -Infinity;
    for (const arr of arrays) {
      if (arr[d] < a) a = arr[d];
      if (arr[d] > z) z = arr[d];
    }
    lo[d] = a;
    hi[d] = z;
  }
  return { lo, hi };
}

function withDefaults(options: ForecastOptions = {}): Required<ForecastOptions> {
  const o: Required<ForecastOptions> = { ...DEFAULTS };
  for (const k of Object.keys(options) as (keyof ForecastOptions)[]) {
    const v = options[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    (o as Record<keyof ForecastOptions, unknown>)[k] = v;
  }
  return o;
}

export function forecast(input: ForecastInput, options?: ForecastOptions): ForecastResult {
  const o = withDefaults(options);
  const ret = clean(input.retention, 1, 365, (v) => v > 0 && v <= 1);
  const roas = clean(input.roas, 0, 365, (v) => v >= 0);
  if (ret.length < 2 || roas.length < 1) {
    return { ok: false, needRetention: ret.length < 2, needRoas: roas.length < 1 };
  }

  const notes: Note[] = [];
  for (let i = 1; i < ret.length; i++) {
    if (ret[i].value > ret[i - 1].value) {
      notes.push({
        level: "warn",
        text: `Retention rises from D${ret[i - 1].day} to D${ret[i].day}. Day-N retention should fall over time. Check that these are classic day-N numbers, not rolling retention.`,
      });
    }
  }
  for (let i = 1; i < roas.length; i++) {
    if (roas[i].value < roas[i - 1].value) {
      notes.push({
        level: "warn",
        text: `ROAS falls from D${roas[i - 1].day} to D${roas[i].day}. Cumulative ROAS cannot go down, so that window counts as zero revenue.`,
      });
    }
  }

  const tail = tailExponent(ret);
  const pf = ols(
    ret.map((p) => Math.log(p.day)),
    ret.map((p) => Math.log(p.value)),
  );
  if (tail.b < 0.15) {
    notes.push({
      level: "warn",
      text: `The retention tail is very flat (exponent ${tail.b.toFixed(2)}). If that is noise, long-range numbers will run high.`,
    });
  }
  if (tail.b > 1.2) {
    notes.push({
      level: "warn",
      text: `The retention tail is very steep (exponent ${tail.b.toFixed(2)}). Check the last retention points.`,
    });
  }

  const lastRoas = roas[roas.length - 1];
  const lastRet = ret[ret.length - 1];
  if (roas.length === 1 && lastRoas.day === 0) {
    notes.push({
      level: "warn",
      text: "Only install-day ROAS is known. Install day usually earns more per player than later days, so this forecast leans high. Add D3 or D7 ROAS.",
    });
  }
  if (lastRoas.day > lastRet.day) {
    notes.push({
      level: "info",
      text: `ROAS data goes past the last retention point, so retention for D${lastRet.day + 1}–D${lastRoas.day} comes from the fitted tail.`,
    });
  }

  // The trend is measured on the base retention curve.
  const drift = fitDrift(run(ret, roas, tail.b, { p: 0, stop: Infinity }, o).windows);
  if (drift && drift.raw !== drift.perDoubling) {
    notes.push({
      level: "warn",
      text: `The measured ARPDAU trend (${(drift.raw * 100).toFixed(0)}% per doubling) is extreme, so it is capped at ${(drift.perDoubling * 100).toFixed(0)}%.`,
    });
  }

  let mode: ResolvedDriftMode = o.driftMode === "auto" ? (drift ? "trend30" : "flat") : o.driftMode;
  if ((mode === "trend30" || mode === "trend") && !drift) mode = "flat";
  const path: Path =
    mode === "trend30" && drift ? { p: drift.perDoubling, stop: o.trendStop }
    : mode === "trend" && drift ? { p: drift.perDoubling, stop: Infinity }
    : mode === "custom" ? { p: Number(o.driftCustom) || 0, stop: Infinity }
    : { p: 0, stop: Infinity };

  const baseCurves = run(ret, roas, tail.b, path, o);
  const base = { ...baseCurves, payback: firstReach(baseCurves.roas, o.target) };

  // Range: a steeper and a flatter tail, crossed with every revenue path in play.
  const paths: Path[] = [
    path,
    { p: path.p - o.driftSpread, stop: path.stop },
    { p: path.p + o.driftSpread, stop: path.stop },
  ];
  if (drift) paths.push({ p: 0, stop: Infinity }, { p: drift.perDoubling, stop: Infinity });
  const tails = [tail.b + o.tailSpread, Math.max(tail.b - o.tailSpread, o.minTailExp)];
  const runs = tails.flatMap((b) => paths.map((p) => run(ret, roas, b, p, o)));
  const roasBand = minMax(runs.map((r) => r.roas));
  const retBand = minMax(runs.map((r) => r.R));
  const uBand = minMax(runs.map((r) => r.u));
  const band: Band = {
    roasLow: roasBand.lo,
    roasHigh: roasBand.hi,
    retLow: retBand.lo,
    retHigh: retBand.hi,
    uLow: uBand.lo,
    uHigh: uBand.hi,
    paybackLow: firstReach(roasBand.lo, o.target),
    paybackHigh: firstReach(roasBand.hi, o.target),
  };

  const checks: Forecast["checks"] = {};
  if (roas.length >= 2) {
    const prev = roas.slice(0, -1);
    const prevDrift = prev.length >= 3 ? fitDrift(run(ret, prev, tail.b, { p: 0, stop: Infinity }, o).windows) : null;
    const prevPath: Path =
      (mode === "trend30" || mode === "trend") && prevDrift ? { p: prevDrift.perDoubling, stop: path.stop }
      : mode === "custom" ? path
      : { p: 0, stop: Infinity };
    const s = run(ret, prev, tail.b, prevPath, o);
    checks.roas = {
      fromDay: prev[prev.length - 1].day,
      day: lastRoas.day,
      predicted: s.roas[lastRoas.day],
      actual: lastRoas.value,
    };
  }
  if (ret.length >= 3) {
    const prevRet = ret.slice(0, -1);
    const tb = tailExponent(prevRet);
    const anchor = prevRet[prevRet.length - 1];
    checks.retention = {
      toDay: anchor.day,
      day: lastRet.day,
      predicted: anchor.value * Math.pow(lastRet.day / anchor.day, -Math.max(tb.b, o.minTailExp)),
      actual: lastRet.value,
    };
  }

  return {
    ok: true,
    options: o,
    retention: ret,
    roas,
    lastRoasDay: lastRoas.day,
    lastRoasValue: lastRoas.value,
    lastRetentionDay: lastRet.day,
    tail,
    powerFit: { a: Math.exp(pf.intercept), b: -pf.slope, r2: pf.r2 },
    drift,
    mode,
    path,
    base,
    band,
    checks,
    notes,
  };
}
