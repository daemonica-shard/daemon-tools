import { describe, expect, it } from "vitest";
import { AppLovinError, AppLovinReporting, type ReportRequest } from "../src/reporting.js";

const KEY = "SECRET-REPORT-KEY_0123456789";
const REQUEST: ReportRequest = { reportType: "advertiser", start: "2026-11-01", end: "2026-11-02", columns: ["day", "campaign", "cost"] };

function scripted(answers: Array<Response | Error>, retries = 3) {
  const urls: string[] = [];
  const sleeps: number[] = [];
  const client = new AppLovinReporting({
    apiKey: KEY,
    retries,
    fetch: (async (url: string | URL | Request) => {
      urls.push(String(url));
      const next = answers.shift();
      if (!next) throw new Error("the script ran out of answers");
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, urls, sleeps };
}

describe("report", () => {
  it("asks for CSV of the given report type, days and columns", async () => {
    const { client, urls } = scripted([new Response("Day,Campaign,Cost\n2026-11-01,A,$1.50\n")]);
    expect(await client.report(REQUEST)).toBe("Day,Campaign,Cost\n2026-11-01,A,$1.50\n");
    const url = new URL(urls[0]);
    expect(url.origin + url.pathname).toBe("https://r.applovin.com/report");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      api_key: KEY, start: "2026-11-01", end: "2026-11-02", format: "csv", report_type: "advertiser", columns: "day,campaign,cost",
    });
  });

  // The key is in the URL, and both fetch's errors and a server echoing the request can carry it.
  it("never lets the key into an error", async () => {
    const echoed = scripted([new Response(`Invalid request for api_key=${KEY}`, { status: 400 })]);
    const err = await echoed.client.report(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppLovinError);
    expect((err as AppLovinError).status).toBe(400);
    expect((err as Error).message).toContain("Invalid request for api_key=<report key>");
    expect((err as Error).message).not.toContain(KEY);

    const network = scripted([new TypeError(`fetch failed for https://r.applovin.com/report?api_key=${KEY}`)], 0);
    const netErr = await network.client.report(REQUEST).catch((e: unknown) => e);
    expect((netErr as Error).message).not.toContain(KEY);
  });

  it("passes on the 45-day limit as AppLovin words it, without retrying", async () => {
    const { client, urls } = scripted([new Response("Start date is beyond our 45 day look back period.", { status: 400 })]);
    await expect(client.report(REQUEST)).rejects.toThrow(/45 day look back period/);
    expect(urls).toHaveLength(1);
  });

  it("retries server and network errors, then gives up", async () => {
    const recovered = scripted([new Response("busy", { status: 503 }), new TypeError("fetch failed"), new Response("Day\n")]);
    await expect(recovered.client.report(REQUEST)).resolves.toBe("Day\n");
    expect(recovered.sleeps).toEqual([10_000, 20_000]);

    const down = scripted([new Response("oops", { status: 500 }), new Response("oops", { status: 500 })], 1);
    await expect(down.client.report(REQUEST)).rejects.toThrow(/2 times in a row, last with: oops/);
  });

  it("rejects bad dates and column names before calling AppLovin", async () => {
    const { client, urls } = scripted([]);
    await expect(client.report({ ...REQUEST, start: "1.11.2026" })).rejects.toThrow(/yyyy-mm-dd/);
    await expect(client.report({ ...REQUEST, columns: ["cost&api_key=x"] })).rejects.toThrow(/column name/);
    expect(urls).toHaveLength(0);
  });
});
