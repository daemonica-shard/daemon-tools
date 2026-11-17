# roas-forecast

Forecasts a cohort's ROAS curve and payback day from early retention and early ROAS: D1/D7
retention plus D0/D7 ROAS in, D30/D90/D365 ROAS and a payback day out, with a range. It ships
as two things built from the same code:

- a **library** (`@daemon-tools/roas-forecast`) the MCP server or a job can import;
- a **single-file page** with charts, a forecast table and break-even tROAS goals. It reads an
  Adjust report export directly.

## The page

```sh
pnpm --filter @daemon-tools/roas-forecast page                    # no data: type a cohort in, or load a CSV in the page
pnpm --filter @daemon-tools/roas-forecast page --csv ~/Downloads/2026-03-31_adjust_report_export.csv
open lib/roas-forecast/dist/roas-forecast.html
```

`--csv` bundles the export into the page, keeping only the columns it reads. Without it, the
page opens on example numbers and a **Load export…** button reads a CSV in the browser. Nothing
is uploaded anywhere.

> **This repo is public.** A page built with `--csv` carries spend, ROAS and campaign names. The
> build only writes it to a `dist/` folder (gitignored) or outside the repo. Don't commit
> exports.

The export it expects is Adjust's report export **grouped by day**. It needs `installs` and
`retention_rate_dN`, plus `cost` and `roas_dN` for ROAS (falling back to `roas_ad_dN`). Any of
`app`, `channel`, `campaign_network`, `country` … present become filters. Keep the date Adjust
puts in the file name: the page uses it to tell finished cohort days from ones still filling in.

The page opens on the **total**: every channel and campaign, including installs without spend
(organic, untrusted devices like Adjust's Anomaly bucket). Their revenue isn't in `roas_dN`
because they have no cost, so add `all_revenue` to the export to estimate it (see below), or
cohort revenue totals for every ROAS day to count it exactly: `all_revenue_total_dN`, or
`ad_revenue_total_dN` with `revenue_total_dN` (Adjust's `revenue_total` is in-app purchases only).

## The library

```ts
import { aggregateCohorts, forecast, loadAdjustExport } from "@daemon-tools/roas-forecast";

const data = loadAdjustExport(csvText, "2026-03-31_adjust_report_export.csv");
if (data.ok) {
  const curve = aggregateCohorts(data, { dims: { campaign_network: "My_tROAS_D7_campaign" } });
  const f = forecast(curve, { target: 1 });
  if (f.ok) console.log(f.base.roas[365], f.base.payback, f.band.paybackHigh, f.band.paybackLow);

  const total = aggregateCohorts(data); // every row, installs without spend included
  console.log(total.unpaid.revenue, total.unpaid.uplift, total.summary.blendedCpi);
  const paid = aggregateCohorts(data, { spend: "paid" }); // only rows with spend
}
```

`forecast` also takes plain points (`{ retention: [{ day: 1, value: 0.4 }, …], roas: [{ day: 7,
value: 0.2 }] }`), so any source works, not only Adjust. It is pure: no I/O, no clock.

## How the forecast works

ROAS on day N is revenue per install by day N ÷ CPI, and revenue only arrives on days a player
shows up:

```
LT(N)   = R(0) + R(1) + … + R(N)                    days played per install; R(0) = 1
u       = (ROAS(n₂) − ROAS(n₁)) ÷ (LT(n₂) − LT(n₁))  revenue per active player per day ÷ CPI, per window
ROAS(N) = ROAS(n) + Σ R(d) · u(d), d = n+1 … N
```

1. **Retention → days played.** Measured days are interpolated on log-log scales; past the last
   one the curve continues as a power law `R(L) · (d/L)^-b`, with `b` fitted on the last two
   doublings of age (onboarding churn decays differently from the tail).
2. **ROAS → revenue per day played.** Each gap between two ROAS readings divided by the days
   played inside it. Install day gets its own window when D0 ROAS is known.
3. **Forward.** Past the last reading, `u` follows a path: flat, the measured trend until D30
   then flat (the default when a trend is measurable), the trend throughout, or a custom % per
   doubling of player age. With one reading and a flat path this is the textbook
   `ROAS(N) = ROAS(n) · LT(N) / LT(n)`, where CPI cancels out.
4. **Range.** A tail exponent ± 0.10, crossed with every path in play (flat, the measured trend,
   and ± 5% per doubling around the chosen one). It's a spread of assumptions, not a
   confidence interval.

The revenue path is usually the assumption that matters most. Ad-monetized games tend to earn
less per active player as the cohort ages, and holding flat versus following that decline can
move payback by months.

## How an Adjust export is read

- **Finished days only.** Cells for days that haven't finished are partial: the export day reads
  near zero and the day before still runs low. A cohort counts toward day N only when
  `install date + N ≤ export date − 2`.
- **Cohorts are install days.** The rows of one install day (one per campaign, channel …) form
  one cohort.
- **Chain-ladder.** Older days have fewer finished cohorts, and they can be a different mix (a
  weak launch week). Averaged per day, that mix bends the curve. Instead, each later day
  multiplies the previous one by the growth seen in cohorts that finished both. Retention is
  weighted by installs; ROAS is the selection's revenue ÷ its spend.
- **Thin days are dropped.** A day needs ≥ 3 finished cohorts carrying ≥ 10% of the selection's
  installs (spend, for ROAS); the curve stops at the first day that doesn't, and `skipped` says
  which.
- **Installs without spend** have no ROAS of their own, so a total built from `roas_dN` alone
  misses their revenue. `unpaid.revenue` says how they were handled:
  - `counted`: the export has cohort revenue totals for every ROAS day, so ROAS is revenue ÷
    spend over every row.
  - `estimated`: ROAS is raised by `unpaid.uplift`, their revenue by event date (`all_revenue`,
    or `ad_revenue` + `revenue`) as a share of paid installs' over the same dates. This assumes
    their revenue builds up with player age the way paid revenue does. Revenue by event date
    can include players who installed before the export's first day, on both sides of the
    ratio.
  - `missing`: neither, so they count toward retention only.

  Once their revenue counts, pair ROAS with `summary.blendedCpi` (spend ÷ all installs), not
  `summary.cpi` (spend ÷ paid installs).
- Day 0 is install day, and `roas_dN` counts revenue from day 0 through day N.

## Tests

```sh
pnpm --filter @daemon-tools/roas-forecast test
```

All fixtures are synthetic. Never use a real export in a test here.
