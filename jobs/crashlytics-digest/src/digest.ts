import { describeTableName, type TopCrash, type VersionRow } from "@daemon-tools/crashlytics";

export interface AppReport {
  table: string;
  crashes: TopCrash[];
  versions: VersionRow[];
}

/** Events per install above which one device is clearly looping rather than many users hitting it. */
const LOOP_RATIO = 8;

export function compact(n: number): string {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * Issue titles carry a whole stack in some cases — the manual-exception ones run to hundreds of
 * characters — and a chat message cannot absorb that.
 */
export function shorten(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Titles the export emits that carry no information on their own. */
const PLACEHOLDER_TITLES = new Set(["<empty stack>", "Missing information"]);

/**
 * A bare exception class is a placeholder in practice: the same ButtonAudio issue arrives titled
 * `java.lang.Exception` on Android and `<empty stack>` on iOS, and only the subtitle says which
 * button broke. Anything with a space in it — `Native method - …`, `[libil2cpp.so]` — is real.
 */
function isWeakTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title) || /^[\w.]+(Exception|Error)$/.test(title);
}

/** Best short name for an issue: the title if it says anything, else blame frame, else subtitle. */
export function label(crash: TopCrash): string {
  const title = crash.title?.trim();
  if (title && !isWeakTitle(title)) return shorten(title);
  const blame = [crash.blame_file, crash.blame_symbol].filter(Boolean).join(" · ");
  if (blame) return shorten(blame);
  const subtitle = crash.subtitle?.trim();
  return shorten(subtitle || title || crash.issue_id);
}

/** First seen inside the window, so it did not exist before this digest's period. */
export function isNew(crash: TopCrash, windowStart: Date): boolean {
  return new Date(crash.first_seen.value) >= windowStart;
}

/**
 * A crash loop looks catastrophic by event count and affects nobody but the one device stuck in it.
 * Worth flagging rather than filtering — a loop is a real bug, just not a widespread one.
 */
export function isLoop(crash: TopCrash): boolean {
  return crash.affected_installs > 0 && crash.events / crash.affected_installs >= LOOP_RATIO;
}

function line(crash: TopCrash): string {
  const installs = `${crash.affected_installs} install${crash.affected_installs === 1 ? "" : "s"}`;
  const loop = isLoop(crash) ? ` [loop: ${compact(crash.events)} events]` : "";
  return `    ${installs} · ${crash.error_type} · ${label(crash)}${loop}`;
}

function versionLine(versions: VersionRow[]): string | null {
  if (!versions.length) return null;
  // Newest-looking version wins ties: the export gives no release date, and display_version sorts
  // usefully for the x.yy.zz scheme both games use.
  const top = [...versions].sort((a, b) => (b.version ?? "").localeCompare(a.version ?? ""))[0];
  const forVersion = versions.filter((v) => v.version === top.version);
  const parts = forVersion
    .sort((a, b) => b.events - a.events)
    .map((v) => `${v.events} ${v.error_type}`);
  return `  Latest ${top.version ?? "unknown"}: ${parts.join(", ")}`;
}

function section(report: AppReport, windowStart: Date, limit: number): string[] {
  const { app, platform } = describeTableName(report.table);
  const heading = `${app} ${platform}`;

  if (!report.crashes.length) return [`${heading} — clean`];

  const installs = report.crashes.reduce((max, c) => Math.max(max, c.affected_installs), 0);
  const events = report.crashes.reduce((sum, c) => sum + c.events, 0);
  const fatal = report.crashes.filter((c) => c.fatal).length;

  const lines = [
    `${heading} — ${report.crashes.length} issues · ${compact(events)} events · ` +
      `up to ${installs} installs${fatal ? ` · ${fatal} fatal` : ""}`,
  ];

  const fresh = report.crashes.filter((c) => isNew(c, windowStart));
  if (fresh.length) {
    lines.push("  New:");
    lines.push(...fresh.slice(0, limit).map(line));
  }

  // Ongoing issues are ranked by installs already, so the head of the list is the widest-reaching
  // thing that was not new — which is what survives triage when nothing is on fire.
  const ongoing = report.crashes.filter((c) => !isNew(c, windowStart));
  if (ongoing.length) {
    lines.push("  Ongoing:");
    lines.push(...ongoing.slice(0, limit).map(line));
  }

  const versions = versionLine(report.versions);
  if (versions) lines.push(versions);

  return lines;
}

// Plain text, no Markdown: Telegram's parsers reject unescaped `-`, `.` and `(`, which appear in
// almost every stack frame here.
export function formatDigest(
  reports: AppReport[],
  options: { days: number; now: Date; limit?: number },
): string {
  const { days, now, limit = 5 } = options;
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const period = days === 1 ? "last 24h" : `last ${days} days`;

  const withData = reports.filter((r) => r.crashes.length);
  if (!withData.length) {
    return `Crashlytics — ${period}\n\nNo crashes reported across ${reports.length} app(s).`;
  }

  const lines = [`Crashlytics — ${period}`, ""];
  for (const report of reports) {
    lines.push(...section(report, windowStart, limit), "");
  }
  return lines.join("\n").trimEnd();
}
