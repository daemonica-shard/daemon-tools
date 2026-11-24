import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildPage, bundleLibrary, loadBundle } from "../scripts/build-page.mjs";
import { forecast, type Forecast } from "../src/model.js";

const INPUT = {
  retention: [
    { day: 1, value: 0.4 },
    { day: 7, value: 0.15 },
  ],
  roas: [{ day: 7, value: 0.2 }],
};

const CSV = [
  "day,installs,cost,secret_column,retention_rate_d1,retention_rate_d7,roas_d0,roas_d7,all_revenue,gross_profit",
  "2026-03-01,10,20,do-not-ship,0.3,0.1,0.1,0.2,5,-15",
].join("\n");

function bundledCsv(html: string): string {
  return /<script type="text\/csv" id="bundled-export"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
}

function hostConfig(html: string): unknown {
  return JSON.parse(/<script type="application\/json" id="host-config">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "null");
}

function scripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

describe("page build", () => {
  it("bundles the same model the server imports", () => {
    const lib = loadBundle(bundleLibrary());
    const fromPage = lib.forecast(INPUT) as Forecast;
    const direct = forecast(INPUT) as Forecast;
    expect(fromPage.base.roas[365]).toBeCloseTo(direct.base.roas[365], 12);
    expect(fromPage.base.payback).toBe(direct.base.payback);
  });

  it("builds a page whose scripts parse, with and without an export", () => {
    for (const csv of [undefined, { text: CSV, name: "2026-03-31_adjust_report_export.csv" }]) {
      const { html } = buildPage({ csv });
      expect(html).not.toMatch(/@BUNDLED_|@HOST_CONFIG@|\/\*@LIBRARY@\*\//);
      expect(hostConfig(html)).toEqual({});
      for (const s of scripts(html)) expect(() => new vm.Script(s)).not.toThrow();
    }
  });

  it("tells a hosted page where the shared export lives, without letting a value close the script", () => {
    const { html } = buildPage({ host: { api: "api/export", note: "</script><b>" } });
    expect(hostConfig(html)).toEqual({ api: "api/export", note: "</script><b>" });
    expect(html).not.toContain("</script><b>");
  });

  it("bundles only the columns the page reads", () => {
    const { html, columns } = buildPage({ csv: { text: CSV, name: "2026-03-31_adjust_report_export.csv" } });
    expect(columns).toBe(8);
    // Revenue by event date stays: it sizes what installs without spend earn.
    expect(bundledCsv(html).split("\n")[0]).toBe("day,installs,cost,retention_rate_d1,retention_rate_d7,roas_d0,roas_d7,all_revenue");
    expect(html).not.toContain("secret_column");
    expect(html).not.toContain("do-not-ship");
    expect(html).not.toContain("gross_profit");
  });
});
