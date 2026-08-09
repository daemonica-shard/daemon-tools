import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DayUsage } from "./ccusage.js";

export interface Archive {
  updatedAt: string;
  days: Record<string, DayUsage>; // keyed by YYYY-MM-DD
}

export const EMPTY: Archive = { updatedAt: "", days: {} };

// Why this job exists: ccusage can only see transcripts Claude Code still has on disk, and those
// are pruned (cleanupPeriodDays, 30 by default). Every run therefore reports a sliding window, and
// the archive is the union of every window ever seen.
//
// Merge rule is max-by-total, not last-write-wins. A day still in the window can only grow (today's
// numbers rise as you work); a day that has aged out disappears from the report entirely rather
// than coming back smaller. So a smaller number for a day we already hold is always the worse
// reading, and taking the max is what keeps pruned history intact.
export function merge(archive: Archive, days: DayUsage[], now: string): Archive {
  const days_ = { ...archive.days };
  for (const day of days) {
    const held = days_[day.period];
    if (!held || day.totalTokens >= held.totalTokens) days_[day.period] = day;
  }
  return { updatedAt: now, days: days_ };
}

export async function load(path: string): Promise<Archive> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<Archive>;
  return { updatedAt: parsed.updatedAt ?? "", days: parsed.days ?? {} };
}

// Write-then-rename. The pruned days in here exist nowhere else, so a crash mid-write must not be
// able to leave a truncated file where the archive used to be.
export async function save(path: string, archive: Archive): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
