import { describe, expect, it } from "vitest";
import { AppMetricaClient, AppMetricaError, type ExportRequest, type ExportWait } from "../src/client.js";

const TOKEN = "y0_SECRET-OAUTH-TOKEN";

const REQUEST: ExportRequest = {
  applicationId: 1234567,
  table: "ad_revenue_events",
  since: "2026-11-20 00:00:00",
  until: "2026-11-20 23:59:59",
  fields: ["appmetrica_device_id", "ad_revenue"],
  dateDimension: "receive",
};

/** A client whose fetch answers from a script, and whose sleeps advance a fake clock instead of waiting. */
function scripted(answers: Array<Response | Error>, options: { retries?: number; exportTimeoutMs?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  let clock = 0;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("the script ran out of answers");
    if (next instanceof Error) throw next;
    return next;
  };
  const client = new AppMetricaClient({
    token: TOKEN,
    fetch: fetch as typeof globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...options,
  });
  return { client, calls, sleeps };
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe("exportUrl", () => {
  it("encodes the query the way AppMetrica's own samples do", () => {
    const { client } = scripted([]);
    const url = client.exportUrl({ ...REQUEST, filters: { ad_revenue_data_source: "manual" } });
    expect(url).toBe(
      "https://api.appmetrica.yandex.com/logs/v1/export/ad_revenue_events.csv" +
        "?application_id=1234567" +
        "&date_since=2026-11-20%2000%3A00%3A00" +
        "&date_until=2026-11-20%2023%3A59%3A59" +
        "&fields=appmetrica_device_id%2Cad_revenue" +
        "&skip_unavailable_shards=true" +
        "&date_dimension=receive" +
        "&ad_revenue_data_source=manual",
    );
  });

  // Filters travel as plain field=value parameters, so these would silently change the export.
  it("rejects names that would break or hijack the query", () => {
    const { client } = scripted([]);
    expect(() => client.exportUrl({ ...REQUEST, fields: ["ad_revenue&limit=1"] })).toThrow(/field name/);
    expect(() => client.exportUrl({ ...REQUEST, filters: { date_until: "2030-01-01" } })).toThrow(/filter field/);
    expect(() => client.exportUrl({ ...REQUEST, since: "20.11.2026" })).toThrow(/Dates/);
    expect(() => client.exportUrl({ ...REQUEST, table: "nope" as never })).toThrow(/table/);
  });
});

describe("exportLogs", () => {
  it("repeats the identical request while the file is prepared, then returns it", async () => {
    const { client, calls, sleeps } = scripted([
      new Response("Wait for result", { status: 202 }),
      new Response("Wait for result", { status: 202 }),
      new Response("appmetrica_device_id,ad_revenue\n42,0.0125\n", { status: 200, headers: { "Shards-Unavailable": "0" } }),
    ]);
    const waits: ExportWait[] = [];

    const file = await client.exportLogs(REQUEST, { onWait: (w) => waits.push(w) });

    expect(await new Response(file.body).text()).toBe("appmetrica_device_id,ad_revenue\n42,0.0125\n");
    expect(file).toMatchObject({ shardsUnavailable: 0, polls: 3 });
    expect(new Set(calls.map((c) => c.url)).size).toBe(1);
    expect(calls.every((c) => headersOf(c.init).Authorization === `OAuth ${TOKEN}`)).toBe(true);
    expect(sleeps).toEqual([5_000, 7_500]);
    expect(waits.map((w) => [w.reason, w.detail])).toEqual([
      ["preparing", "Wait for result"],
      ["preparing", "Wait for result"],
    ]);
  });

  it("waits out a full queue instead of failing", async () => {
    const { client, sleeps } = scripted([
      new Response("There are already 3 enqueued queries for given application_id.", { status: 429 }),
      new Response("a\n", { status: 200, headers: { "Shards-Unavailable": "0" } }),
    ]);
    const waits: ExportWait[] = [];
    await client.exportLogs(REQUEST, { onWait: (w) => waits.push(w) });
    expect(waits[0].reason).toBe("queue-full");
    expect(sleeps).toHaveLength(1);
  });

  // A file missing some shards is still a 200, and the header is the only sign. Complete exports
  // (as seen on the live API) don't send it at all.
  it("reports unavailable shards, reading a missing header as complete", async () => {
    const partial = scripted([new Response("a\n", { status: 200, headers: { "Shards-Unavailable": "12.5" } })]);
    expect((await partial.client.exportLogs(REQUEST)).shardsUnavailable).toBe(12.5);
    const complete = scripted([new Response("a\n", { status: 200 })]);
    expect((await complete.client.exportLogs(REQUEST)).shardsUnavailable).toBe(0);
  });

  it("passes on the row count AppMetrica reports", async () => {
    const counted = scripted([new Response("a\n1\n", { status: 200, headers: { "rows-number": "1" } })]);
    expect((await counted.client.exportLogs(REQUEST)).rows).toBe(1);
    const uncounted = scripted([new Response("a\n1\n", { status: 200 })]);
    expect((await uncounted.client.exportLogs(REQUEST)).rows).toBeNull();
  });

  // Without max-age, AppMetrica hands back any identical request's file from the last 24 hours,
  // e.g. one taken while the day was still filling in.
  it("asks for a recent enough file with Cache-Control: max-age", async () => {
    const { client, calls } = scripted([new Response("a\n", { status: 200, headers: { "Shards-Unavailable": "0" } })]);
    await client.exportLogs({ ...REQUEST, maxAgeSeconds: 300.7 });
    expect(headersOf(calls[0].init)["Cache-Control"]).toBe("max-age=300");
  });

  it("retries server and network errors, then gives up", async () => {
    const recovered = scripted([
      new Response("Bad gateway", { status: 502 }),
      new TypeError("fetch failed"),
      new Response("a\n", { status: 200, headers: { "Shards-Unavailable": "0" } }),
    ]);
    await expect(recovered.client.exportLogs(REQUEST)).resolves.toMatchObject({ polls: 1 });
    expect(recovered.sleeps).toEqual([15_000, 30_000]);

    const down = scripted([new Response("oops", { status: 500 }), new Response("oops", { status: 500 })], { retries: 1 });
    await expect(down.client.exportLogs(REQUEST)).rejects.toThrow(/2 times in a row, last with: 500 oops/);
  });

  it("fails on a bad request with AppMetrica's explanation, and never with the token", async () => {
    const { client } = scripted([new Response("Unknown field: ad_revenue_value", { status: 400 })]);
    const err = await client.exportLogs(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppMetricaError);
    expect((err as AppMetricaError).status).toBe(400);
    expect((err as Error).message).toContain("Unknown field: ad_revenue_value");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  // The docs say 401; the live API says 403 with this body.
  it("recognises a bad token by status or by error type", async () => {
    const invalid = { errors: [{ error_type: "invalid_token", message: "Invalid oauth_token" }], code: 403, message: "Invalid oauth_token" };
    const live = scripted([Response.json(invalid, { status: 403 })]);
    await expect(live.client.exportLogs(REQUEST)).rejects.toThrow(
      "AppMetrica answered 403 to the ad_revenue_events export. The OAuth token is missing, invalid, expired or revoked. (Invalid oauth_token)",
    );
    const documented = scripted([new Response("", { status: 401 })]);
    await expect(documented.client.exportLogs(REQUEST)).rejects.toThrow(/missing, invalid, expired or revoked/);
    const denied = scripted([Response.json({ message: "Access denied" }, { status: 403 })]);
    await expect(denied.client.exportLogs(REQUEST)).rejects.toThrow(/may not have access to this app. \(Access denied\)/);
  });

  it("gives up after the export timeout", async () => {
    const answers = Array.from({ length: 20 }, () => new Response("Wait for result", { status: 202 }));
    const { client } = scripted(answers, { exportTimeoutMs: 60_000 });
    await expect(client.exportLogs(REQUEST)).rejects.toThrow(/still preparing the ad_revenue_events export/);
  });
});

describe("management calls", () => {
  it("lists apps with their time zones, agency apps included", async () => {
    const body = {
      applications: [
        { id: 1234567, name: "Bubble Pop", time_zone_name: "Europe/Moscow", time_zone_offset: 10800, permission: "own", api_key128: "x" },
      ],
    };
    const { client, calls } = scripted([Response.json(body)]);
    expect(await client.listApplications()).toEqual([
      { id: 1234567, name: "Bubble Pop", timeZoneName: "Europe/Moscow", timeZoneOffset: 10800, permission: "own" },
    ]);
    expect(calls[0].url).toBe("https://api.appmetrica.yandex.com/management/v1/applications?include_agency_apps=true");
  });

  it("maps active exports and cancels by request id", async () => {
    const { client, calls } = scripted([
      Response.json([
        {
          application_id: 1234567, create_time: "2026-11-24 10:00:00", entity: 13, output_format: 0,
          request_id: "abc", query: "date_since=...", status: 0, total_progress: 0.5, total_rows_loaded: 10, shards_unavailable: 0,
        },
      ]),
      // The live API answers the cancel in plain text.
      new Response("Request cancellation has been scheduled.\n", { status: 200, headers: { "Content-Type": "text/plain" } }),
    ]);
    expect(await client.activeQueries(1234567)).toEqual([
      { requestId: "abc", entity: 13, status: 0, progress: 0.5, rowsLoaded: 10, createTime: "2026-11-24 10:00:00", query: "date_since=..." },
    ]);
    expect(await client.cancelQuery(1234567, "abc")).toBe("Request cancellation has been scheduled.");
    expect(calls[1].url).toBe("https://api.appmetrica.yandex.com/logs/v1/export/abc/cancel?application_id=1234567");
    expect(calls[1].init.method).toBe("POST");
  });
});
