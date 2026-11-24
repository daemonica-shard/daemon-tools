import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Application, ExportFile, ExportRequest } from "@daemon-tools/appmetrica";
import { assertOutsideRepo, findApp, readToken } from "../src/config.js";
import { chunks, dayEnd, days, localDate, sync, type DayRecord, type TableSpec } from "../src/sync.js";

// Moscow, UTC+3. "Now" is 2026-11-24 15:00 there.
const APP: Application = { id: 1234567, name: "Bubble Pop", timeZoneName: "Europe/Moscow", timeZoneOffset: 10800, permission: "own" };
const NOW = Date.parse("2026-11-24T12:00:00Z");
const DAY_COLUMN = "ad_revenue_receive_datetime";
const SPEC: TableSpec = {
  table: "ad_revenue_events",
  fields: ["appmetrica_device_id", "ad_revenue", DAY_COLUMN],
  dayColumn: DAY_COLUMN,
};

/** Two rows per requested day, each arriving at noon that day. */
function csvFor(req: ExportRequest): string {
  const rows = days(req.since.slice(0, 10), req.until.slice(0, 10)).flatMap((day) => [
    `1,0.01,${day} 12:00:00`,
    `2,0.02,${day} 12:00:00`,
  ]);
  return `appmetrica_device_id,ad_revenue,${DAY_COLUMN}\n${rows.join("\n")}\n`;
}

type Answer = Partial<ExportFile> & { csv?: string };

/** A client that answers every export at once, recording what was asked. */
function fakeClient(answer: (req: ExportRequest) => Answer = () => ({})) {
  const requests: ExportRequest[] = [];
  return {
    requests,
    exportLogs: async (req: ExportRequest): Promise<ExportFile> => {
      requests.push(req);
      const { csv = csvFor(req), ...rest } = answer(req);
      return { body: new Response(csv).body!, shardsUnavailable: 0, rows: null, polls: 1, waitedMs: 0, ...rest };
    },
  };
}

async function readParquet(path: string): Promise<Record<string, unknown>[]> {
  const db = await DuckDBInstance.create(":memory:");
  const connection = await db.connect();
  try {
    return (await connection.runAndReadAll(`FROM '${path}'`)).getRowObjects();
  } finally {
    connection.closeSync();
    db.closeSync();
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "appmetrica-logs-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fileOf = (date: string, ext: string) => join(dir, SPEC.table, `${date}.${ext}`);
const record = async (date: string) => JSON.parse(await readFile(fileOf(date, "json"), "utf8")) as DayRecord;
const pullDays = (client: ReturnType<typeof fakeClient>, since: string, until: string, extra: object = {}) =>
  sync({ client, app: APP, tables: [SPEC], since, until, dir, now: () => NOW, ...extra });
const ranges = (client: ReturnType<typeof fakeClient>) => client.requests.map((r) => `${r.since.slice(0, 10)}..${r.until.slice(0, 10)}`);

describe("dates", () => {
  it("lists every day of the range, both ends included, across a month", () => {
    expect(days("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(days("2026-11-02", "2026-11-01")).toEqual([]);
  });

  it("puts day boundaries in the app's time zone", () => {
    expect(new Date(dayEnd("2026-11-20", 10800)).toISOString()).toBe("2026-11-20T21:00:00.000Z");
    expect(localDate(Date.parse("2026-11-23T21:30:00Z"), 10800)).toBe("2026-11-24");
    expect(localDate(Date.parse("2026-11-23T21:30:00Z"), 0)).toBe("2026-11-23");
  });

  it("groups days into runs of consecutive days, never across a gap", () => {
    expect(chunks(["2026-11-24", "2026-11-23", "2026-11-22", "2026-11-20", "2026-11-19"], 2)).toEqual([
      ["2026-11-23", "2026-11-24"],
      ["2026-11-22"],
      ["2026-11-19", "2026-11-20"],
    ]);
    expect(chunks([], 7)).toEqual([]);
  });
});

describe("sync", () => {
  it("downloads each day by arrival time, and marks it final only a full day after it ends", async () => {
    const client = fakeClient(() => ({ rows: 2 }));
    const [summary] = await pullDays(client, "2026-11-21", "2026-11-24");

    expect(ranges(client)).toEqual(["2026-11-24..2026-11-24", "2026-11-23..2026-11-23", "2026-11-22..2026-11-22", "2026-11-21..2026-11-21"]);
    expect(client.requests[0]).toMatchObject({ since: "2026-11-24 00:00:00", until: "2026-11-24 23:59:59", dateDimension: "receive" });
    // Nov 23 ended at 21:00 UTC that day, so it settles at 21:00 UTC on Nov 24, after "now".
    expect((await record("2026-11-23")).final).toBe(false);
    expect((await record("2026-11-22")).final).toBe(true);
    expect(await record("2026-11-22")).toMatchObject({ rows: 2, timeZone: "Europe/Moscow", shardsUnavailable: 0 });
    expect(await readParquet(fileOf("2026-11-22", "parquet"))).toEqual([
      { appmetrica_device_id: "1", ad_revenue: "0.01", [DAY_COLUMN]: "2026-11-22 12:00:00" },
      { appmetrica_device_id: "2", ad_revenue: "0.02", [DAY_COLUMN]: "2026-11-22 12:00:00" },
    ]);
    expect(await readdir(join(dir, SPEC.table))).not.toContainEqual(expect.stringMatching(/\.(csv|part)$/));
    expect(summary).toMatchObject({ exports: 4, downloaded: 4, partial: 2, skipped: 0, rows: 8 });
  });

  it("splits a multi-day export into a file per arrival day", async () => {
    const client = fakeClient();
    const [summary] = await pullDays(client, "2026-11-15", "2026-11-24", { tables: [{ ...SPEC, chunkDays: 7 }] });

    expect(ranges(client)).toEqual(["2026-11-18..2026-11-24", "2026-11-15..2026-11-17"]);
    for (const day of days("2026-11-15", "2026-11-24")) expect((await record(day)).rows).toBe(2);
    expect(await record("2026-11-20")).toMatchObject({ export: { since: "2026-11-18", until: "2026-11-24", rows: 14 }, final: true });
    expect((await record("2026-11-23")).final).toBe(false);
    // The first export holds days still open; the second's last day settled more than a day ago.
    expect(client.requests.map((r) => r.maxAgeSeconds)).toEqual([300, 86_400]);
    expect(summary).toMatchObject({ exports: 2, downloaded: 10, partial: 2, rows: 20 });

    const again = fakeClient();
    await pullDays(again, "2026-11-15", "2026-11-24", { tables: [{ ...SPEC, chunkDays: 7 }] });
    expect(ranges(again)).toEqual(["2026-11-23..2026-11-24"]);
  });

  it("refuses an export with rows outside the requested days, and keeps nothing of it", async () => {
    const stray = `appmetrica_device_id,ad_revenue,${DAY_COLUMN}\n1,0.01,2026-11-20 12:00:00\n2,0.02,2026-11-21 00:00:00\n`;
    await expect(pullDays(fakeClient(() => ({ csv: stray })), "2026-11-20", "2026-11-20")).rejects.toThrow(/1 of 2 rows arrived on days outside/);
    expect(await readdir(join(dir, SPEC.table))).toEqual([]);
  });

  it("refuses a file with fewer rows than AppMetrica reported, and keeps nothing of it", async () => {
    await expect(pullDays(fakeClient(() => ({ rows: 3 })), "2026-11-20", "2026-11-20")).rejects.toThrow(/reported 3 rows but the file holds 2/);
    expect(await readdir(join(dir, SPEC.table))).toEqual([]);
  });

  // Type guessing would turn 14.10 into 14.1 and the id into a number; JSON and commas must survive
  // the CSV quoting.
  it("keeps every value as the text AppMetrica sent", async () => {
    const csv = `appmetrica_device_id,os_version,event_json,${DAY_COLUMN}\n0012,14.10,"{""level"":3,""name"":""a,b""}",2026-11-20 08:00:00\n`;
    const spec = { ...SPEC, fields: ["appmetrica_device_id", "os_version", "event_json", DAY_COLUMN] };
    await pullDays(fakeClient(() => ({ csv })), "2026-11-20", "2026-11-20", { tables: [spec] });
    expect(await readParquet(fileOf("2026-11-20", "parquet"))).toEqual([
      { appmetrica_device_id: "0012", os_version: "14.10", event_json: '{"level":3,"name":"a,b"}', [DAY_COLUMN]: "2026-11-20 08:00:00" },
    ]);
  });

  it("writes empty files with the requested columns when days have no rows", async () => {
    await pullDays(fakeClient(() => ({ csv: "" })), "2026-11-19", "2026-11-20", { tables: [{ ...SPEC, chunkDays: 2 }] });
    expect(await readParquet(fileOf("2026-11-20", "parquet"))).toEqual([]);
    expect((await record("2026-11-19")).rows).toBe(0);
    await pullDays(fakeClient(() => ({ csv: `appmetrica_device_id,ad_revenue,${DAY_COLUMN}\n` })), "2026-11-18", "2026-11-18");
    expect((await record("2026-11-18")).rows).toBe(0);
  });

  // A cached file from before a day settled would hold it half filled in, and so would one more
  // than a few minutes old for a day still open.
  it("asks for files no older than the moment the day settled", async () => {
    const client = fakeClient();
    await pullDays(client, "2026-11-21", "2026-11-24");
    const maxAge = Object.fromEntries(client.requests.map((r) => [r.since.slice(0, 10), r.maxAgeSeconds]));
    expect(maxAge).toEqual({
      "2026-11-24": 300,
      "2026-11-23": 300,
      "2026-11-22": 15 * 3600, // settled at 2026-11-23 21:00 UTC, 15 hours before now
      "2026-11-21": 86_400, // settled 39 hours ago; files are only kept for 24
    });
  });

  it("skips final days on the next run and fetches the rest again", async () => {
    await pullDays(fakeClient(), "2026-11-21", "2026-11-24");
    const again = fakeClient();
    const [summary] = await pullDays(again, "2026-11-21", "2026-11-24");
    expect(ranges(again)).toEqual(["2026-11-24..2026-11-24", "2026-11-23..2026-11-23"]);
    expect(summary).toMatchObject({ downloaded: 2, skipped: 2 });
  });

  it("fetches a final day again when its columns change, or on --refresh", async () => {
    await pullDays(fakeClient(), "2026-11-21", "2026-11-21");
    const wider = { tables: [{ ...SPEC, fields: [...SPEC.fields, "os_name"] }] };
    const widened = fakeClient();
    await pullDays(widened, "2026-11-21", "2026-11-21", wider);
    expect(widened.requests).toHaveLength(1);
    const unchanged = fakeClient();
    await pullDays(unchanged, "2026-11-21", "2026-11-21", wider);
    expect(unchanged.requests).toHaveLength(0);
    const refreshed = fakeClient();
    await pullDays(refreshed, "2026-11-21", "2026-11-21", { ...wider, refresh: true });
    expect(refreshed.requests).toHaveLength(1);
  });

  it("keeps a settled day partial while AppMetrica reports unreadable shards", async () => {
    await pullDays(fakeClient(() => ({ shardsUnavailable: 4 })), "2026-11-20", "2026-11-20");
    expect((await record("2026-11-20")).final).toBe(false);
    const again = fakeClient();
    await pullDays(again, "2026-11-20", "2026-11-20");
    expect(again.requests).toHaveLength(1);
    expect((await record("2026-11-20")).final).toBe(true);
  });

  it("stops at the first failure and leaves no half-written file behind", async () => {
    const broken = {
      exportLogs: async (): Promise<ExportFile> => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`appmetrica_device_id,ad_revenue,${DAY_COLUMN}\n1,`));
            controller.error(new Error("connection reset"));
          },
        }),
        shardsUnavailable: 0,
        rows: null,
        polls: 1,
        waitedMs: 0,
      }),
    };
    await expect(
      sync({ client: broken, app: APP, tables: [SPEC], since: "2026-11-20", until: "2026-11-22", dir, parallel: 1, now: () => NOW }),
    ).rejects.toThrow(/connection reset/);
    expect(await readdir(join(dir, SPEC.table))).toEqual([]);
  });
});

describe("config", () => {
  it("refuses to write inside the repo, but not next to it", () => {
    expect(() => assertOutsideRepo("/code/daemon-tools", "/code/daemon-tools")).toThrow(/public/);
    expect(() => assertOutsideRepo("/code/daemon-tools/data", "/code/daemon-tools")).toThrow(/public/);
    expect(() => assertOutsideRepo("/code/daemon-tools-data", "/code/daemon-tools")).not.toThrow();
    expect(() => assertOutsideRepo("/home/me/ai-room/appmetrica", "/code/daemon-tools")).not.toThrow();
  });

  it("finds an app by id, or by a unique part of its name", () => {
    const apps = [APP, { ...APP, id: 7654321, name: "Word Game" }, { ...APP, id: 1111111, name: "Word Game iOS" }];
    expect(findApp(apps, "1234567").name).toBe("Bubble Pop");
    expect(findApp(apps, "bubblepop").id).toBe(1234567);
    expect(() => findApp(apps, "word game")).toThrow(/matches 2 apps/);
    expect(() => findApp(apps, "9999999")).toThrow(/No app 9999999/);
  });

  it("reads the token from the environment first, then from the token file", async () => {
    const file = join(dir, "token");
    await writeFile(file, "  from-file\n");
    expect(readToken({ APPMETRICA_TOKEN: "from-env", APPMETRICA_TOKEN_FILE: file })).toBe("from-env");
    expect(readToken({ APPMETRICA_TOKEN_FILE: file })).toBe("from-file");
    expect(() => readToken({ APPMETRICA_TOKEN_FILE: join(dir, "missing") })).toThrow(/No AppMetrica token/);
  });
});
