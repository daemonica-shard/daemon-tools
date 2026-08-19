import { describe, expect, it } from "vitest";
import type { TopCrash, VersionRow } from "@daemon-tools/crashlytics";
import { formatDigest, isLoop, isNew, label, shorten } from "../src/digest.js";

const NOW = new Date("2026-08-19T00:00:00Z");
const YESTERDAY = "2026-08-18T04:00:00Z";
const LAST_MONTH = "2026-07-27T21:22:53Z";

function crash(overrides: Partial<TopCrash> = {}): TopCrash {
  return {
    issue_id: "abc",
    title: "Native method - android.os.MessageQueue.nativePollOnce",
    subtitle: "Root cause for this ANR is unknown",
    error_type: "ANR",
    fatal: false,
    events: 81,
    affected_installs: 56,
    blame_file: "Native method",
    blame_symbol: "android.os.MessageQueue.nativePollOnce",
    blame_line: null,
    first_seen: { value: YESTERDAY },
    last_seen: { value: YESTERDAY },
    ...overrides,
  };
}

// Taken from the real export: a manual exception whose "title" is most of a stack trace.
const HUGE_TITLE =
  "java.lang.Exception : [MANUAL] ButtonAudio error. BlueButton NoConnectionUIView(Clone)   at " +
  "System.Environment.get_StackTrace () <<address> + <address>> 0 in <00000000000000000000>:0 \n  " +
  "at WordGame.CoreSystems.ButtonAudio.OnButtonPress () <<address> + <address>";

describe("shorten", () => {
  it("collapses whitespace and truncates a stack-trace title", () => {
    const out = shorten(HUGE_TITLE);
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out).not.toContain("\n");
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short title alone", () => {
    expect(shorten("SIGSEGV")).toBe("SIGSEGV");
  });
});

describe("label", () => {
  it("prefers the title", () => {
    expect(label(crash({ title: "SIGBUS" }))).toBe("SIGBUS");
  });

  it("falls back to the blame frame when the title is a placeholder", () => {
    // Both of these appear verbatim in the export and carry no information on their own.
    for (const title of ["<empty stack>", "Missing information"]) {
      expect(label(crash({ title, blame_file: "Field.cpp", blame_symbol: "IsNormalStatic" }))).toBe(
        "Field.cpp · IsNormalStatic",
      );
    }
  });

  it("treats a bare exception class as a placeholder", () => {
    // The ButtonAudio issue arrives as `java.lang.Exception` on Android with no blame frame; only
    // the subtitle names the button. A title that is just a type name is no better than none.
    const out = label(
      crash({
        title: "java.lang.Exception",
        blame_file: null,
        blame_symbol: null,
        subtitle: "Exception : [MANUAL] ButtonAudio error. BlueButton",
      }),
    );
    expect(out).toContain("ButtonAudio");
  });

  it("keeps a short title that is not a bare type name", () => {
    expect(label(crash({ title: "[libil2cpp.so]" }))).toBe("[libil2cpp.so]");
  });

  it("falls back to the subtitle when there is no blame frame either", () => {
    const out = label(
      crash({ title: "<empty stack>", blame_file: null, blame_symbol: null, subtitle: "SIGSEGV" }),
    );
    expect(out).toBe("SIGSEGV");
  });
});

describe("isNew", () => {
  const windowStart = new Date("2026-08-18T00:00:00Z");

  it("counts an issue first seen inside the window", () => {
    expect(isNew(crash({ first_seen: { value: YESTERDAY } }), windowStart)).toBe(true);
  });

  it("does not count one that predates it", () => {
    expect(isNew(crash({ first_seen: { value: LAST_MONTH } }), windowStart)).toBe(false);
  });
});

describe("isLoop", () => {
  it("flags one device generating many events", () => {
    // Real shape: GetDraggableWidget, 45 events across 1 install inside five minutes.
    expect(isLoop(crash({ events: 45, affected_installs: 1 }))).toBe(true);
  });

  it("does not flag a widespread issue", () => {
    expect(isLoop(crash({ events: 81, affected_installs: 56 }))).toBe(false);
  });

  it("does not divide by zero", () => {
    expect(isLoop(crash({ events: 5, affected_installs: 0 }))).toBe(false);
  });
});

describe("formatDigest", () => {
  const versions: VersionRow[] = [
    { version: "1.04.01", error_type: "ANR", events: 72, distinct_issues: 35, affected_installs: 48 },
    { version: "1.04.01", error_type: "FATAL", events: 21, distinct_issues: 11, affected_installs: 17 },
    { version: "0.08.02", error_type: "ANR", events: 17, distinct_issues: 3, affected_installs: 7 },
  ];

  it("splits new from ongoing and names the app and platform", () => {
    const text = formatDigest(
      [
        {
          table: "com_tapempire_wordgame_ANDROID",
          crashes: [
            crash({ issue_id: "new", title: "[libil2cpp.so]", first_seen: { value: YESTERDAY } }),
            crash({ issue_id: "old", title: "ButtonAudio", first_seen: { value: LAST_MONTH } }),
          ],
          versions,
        },
      ],
      { days: 1, now: NOW },
    );

    expect(text).toContain("wordgame Android");
    expect(text).toContain("New:");
    expect(text).toContain("[libil2cpp.so]");
    expect(text).toContain("Ongoing:");
    expect(text).toContain("ButtonAudio");
    expect(text).toContain("Latest 1.04.01: 72 ANR, 21 FATAL");
  });

  it("marks a crash loop so its event count is not mistaken for reach", () => {
    const text = formatDigest(
      [
        {
          table: "com_tapempire_wordgame_IOS",
          crashes: [crash({ events: 45, affected_installs: 1, title: "GetDraggableWidget" })],
          versions: [],
        },
      ],
      { days: 1, now: NOW },
    );
    expect(text).toContain("1 install ·");
    expect(text).toContain("[loop: 45 events]");
  });

  it("reports a clean app rather than omitting it", () => {
    const text = formatDigest(
      [
        { table: "com_tapempire_wordgame_IOS", crashes: [], versions: [] },
        { table: "com_tapempire_wordgame_ANDROID", crashes: [crash()], versions: [] },
      ],
      { days: 1, now: NOW },
    );
    expect(text).toContain("wordgame iOS — clean");
  });

  it("says so when nothing crashed anywhere", () => {
    const text = formatDigest(
      [
        { table: "com_tapempire_wordgame_IOS", crashes: [], versions: [] },
        { table: "com_tapempire_wordgame_ANDROID", crashes: [], versions: [] },
      ],
      { days: 1, now: NOW },
    );
    expect(text).toContain("No crashes reported across 2 app(s)");
  });

  it("titles the window in days when it is not a single day", () => {
    const text = formatDigest([{ table: "x_ANDROID", crashes: [], versions: [] }], {
      days: 7,
      now: NOW,
    });
    expect(text).toContain("last 7 days");
  });

  it("honours the per-section limit", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      crash({ issue_id: `i${i}`, title: `issue-${i}`, first_seen: { value: YESTERDAY } }),
    );
    const text = formatDigest(
      [{ table: "com_tapempire_wordgame_ANDROID", crashes: many, versions: [] }],
      { days: 1, now: NOW, limit: 3 },
    );
    expect(text).toContain("issue-2");
    expect(text).not.toContain("issue-3");
  });
});
