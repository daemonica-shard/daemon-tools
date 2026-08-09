import type { Archive } from "./archive.js";
import type { DayUsage } from "./ccusage.js";

export interface Totals {
  days: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
}

export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// Dates are plain YYYY-MM-DD strings and sort lexicographically, so the window is a string compare
// — no timezone to get wrong.
export function shiftDate(date: string, deltaDays: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + deltaDays);
  return at.toISOString().slice(0, 10);
}

export function window(archive: Archive, from: string, to: string): DayUsage[] {
  return Object.values(archive.days)
    .filter((day) => day.period >= from && day.period <= to)
    .sort((a, b) => a.period.localeCompare(b.period));
}

export function sum(days: DayUsage[]): Totals {
  const totals: Totals = {
    days: days.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
  for (const day of days) {
    totals.inputTokens += day.inputTokens;
    totals.outputTokens += day.outputTokens;
    totals.cacheCreationTokens += day.cacheCreationTokens;
    totals.cacheReadTokens += day.cacheReadTokens;
    totals.totalTokens += day.totalTokens;
    totals.totalCost += day.totalCost;
  }
  return totals;
}

function models(days: DayUsage[]): string[] {
  const seen = new Map<string, number>();
  for (const day of days) {
    for (const model of day.modelsUsed ?? []) {
      seen.set(model, (seen.get(model) ?? 0) + day.totalTokens);
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model]) => model.replace(/^claude-/, ""));
}

// Plain text, no Markdown: Telegram's parsers choke on unescaped `-` and `.`, and there is nothing
// here worth formatting anyway.
export function formatDigest(archive: Archive, today: string, windowDays: number): string {
  const from = shiftDate(today, -(windowDays - 1));
  const days = window(archive, from, today);
  const totals = sum(days);
  const all = sum(Object.values(archive.days));

  if (totals.days === 0) return `Claude usage — no activity in the ${windowDays} days to ${today}`;

  const busiest = days.reduce((a, b) => (b.totalTokens > a.totalTokens ? b : a));
  const used = models(days);

  const lines = [
    `Claude usage — ${windowDays} days to ${today}`,
    "",
    `Tokens: ${compact(totals.totalTokens)} over ${totals.days} active ${totals.days === 1 ? "day" : "days"}`,
    `  output ${compact(totals.outputTokens)} · input ${compact(totals.inputTokens)}`,
    `  cache write ${compact(totals.cacheCreationTokens)} · read ${compact(totals.cacheReadTokens)}`,
    `Equivalent API cost: $${totals.totalCost.toFixed(2)}`,
    `Busiest: ${busiest.period} (${compact(busiest.totalTokens)})`,
  ];
  if (used.length) lines.push(`Models: ${used.join(", ")}`);
  lines.push("", `Archive: ${all.days} days, ${compact(all.totalTokens)} tokens, $${all.totalCost.toFixed(2)}`);

  return lines.join("\n");
}
