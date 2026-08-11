#!/usr/bin/env node
// Converts ~/.claude-usage/archive.json into OpenMetrics text with historical timestamps, for
// `promtool tsdb create-blocks-from openmetrics`. See backfill/README.md.
//
// Emitted as GAUGES under their own metric names, deliberately not merged into the live
// claude_code_* counters. Two reasons: the archive holds daily sums while a counter is a running
// total, so backfilling one into the other produces a sawtooth that rate() reads as constant
// resets; and the eras have different provenance (transcripts vs OTLP) and granularity, which a
// chart should show honestly rather than disguise as one continuous series.
import { readFileSync } from "node:fs";

const TOKEN_TYPES = {
  inputTokens: "input",
  outputTokens: "output",
  cacheCreationTokens: "cacheCreation",
  cacheReadTokens: "cacheRead",
};

const path = process.argv[2] ?? `${process.env.HOME}/.claude-usage/archive.json`;
const days = JSON.parse(readFileSync(path, "utf8")).days ?? {};

// A day's total is stamped at 00:00 UTC of that day. OpenMetrics timestamps are seconds.
const samples = [];
for (const [date, day] of Object.entries(days)) {
  const ts = Date.parse(`${date}T00:00:00Z`) / 1000;
  if (Number.isNaN(ts)) throw new Error(`unparseable date key: ${date}`);

  // Per-model only — emitting an unlabelled total as well would double-count under sum().
  for (const m of day.modelBreakdowns ?? []) {
    const model = String(m.modelName ?? "unknown").replace(/["\\]/g, "\\$&");
    for (const [field, type] of Object.entries(TOKEN_TYPES)) {
      const v = m[field];
      if (typeof v === "number" && v > 0) {
        samples.push([ts, `claude_usage_archive_daily_tokens{model="${model}",type="${type}"}`, v]);
      }
    }
    if (typeof m.cost === "number" && m.cost > 0) {
      samples.push([ts, `claude_usage_archive_daily_cost_USD{model="${model}"}`, m.cost]);
    }
  }
}

// promtool requires samples in timestamp order.
samples.sort((a, b) => a[0] - b[0]);

const out = [];
out.push("# HELP claude_usage_archive_daily_tokens Daily tokens recovered from Claude Code transcripts before pruning");
out.push("# TYPE claude_usage_archive_daily_tokens gauge");
out.push("# HELP claude_usage_archive_daily_cost_USD Daily equivalent API cost recovered from the same archive");
out.push("# TYPE claude_usage_archive_daily_cost_USD gauge");
for (const [ts, series, value] of samples) out.push(`${series} ${value} ${ts}`);
out.push("# EOF");

process.stdout.write(out.join("\n") + "\n");
process.stderr.write(`${samples.length} samples across ${Object.keys(days).length} days\n`);
