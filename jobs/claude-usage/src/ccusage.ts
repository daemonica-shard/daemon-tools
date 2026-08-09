import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// One entry per calendar day, as emitted by `ccusage daily --json`. Extra keys ccusage adds
// (modelBreakdowns, metadata, ...) ride along untouched so the archive keeps whatever it recorded.
export interface DayUsage {
  period: string; // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed?: string[];
  [extra: string]: unknown;
}

const DEFAULT_SPEC = "ccusage@latest";

// Invoked through `npx` rather than taken as a dependency: ccusage is a reporting tool we shell out
// to once a night, not something this package builds against. CCUSAGE_SPEC pins a known-good
// version if an upstream release ever changes the JSON shape under us.
export async function fetchDaily(spec: string = process.env.CCUSAGE_SPEC ?? DEFAULT_SPEC): Promise<DayUsage[]> {
  const { stdout } = await run("npx", ["-y", spec, "daily", "--json"], {
    maxBuffer: 64 * 1024 * 1024, // all-time output grows with every day of history
  });

  let parsed: { daily?: unknown };
  try {
    parsed = JSON.parse(stdout) as { daily?: unknown };
  } catch {
    throw new Error(`ccusage did not return JSON (got ${stdout.slice(0, 200)}...)`);
  }

  if (!Array.isArray(parsed.daily)) throw new Error("ccusage returned no `daily` array");
  return parsed.daily as DayUsage[];
}
