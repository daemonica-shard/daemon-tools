import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Application } from "@daemon-tools/appmetrica";

export const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "appmetrica", "token");

/** APPMETRICA_TOKEN, else the file APPMETRICA_TOKEN_FILE names (default ~/.config/appmetrica/token). */
export function readToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.APPMETRICA_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = env.APPMETRICA_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  const fromFile = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (fromFile) return fromFile;
  throw new Error(
    `No AppMetrica token. Set APPMETRICA_TOKEN, or save the token in ${file}. ` +
      "How to get one: jobs/appmetrica-logs/README.md.",
  );
}

/** An app by numeric id, or by a part of its name that matches one app only (case and spaces ignored). */
export function findApp(apps: Application[], wanted: string): Application {
  const list = () => apps.map((a) => `  ${a.id}  ${a.name}`).join("\n") || "  (none)";
  if (/^\d+$/.test(wanted)) {
    const app = apps.find((a) => a.id === Number(wanted));
    if (app) return app;
    throw new Error(`No app ${wanted} among the apps this token can read:\n${list()}`);
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const matches = apps.filter((a) => norm(a.name).includes(norm(wanted)));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No app named like "${wanted}". This token can read:\n${list()}`);
  throw new Error(`"${wanted}" matches ${matches.length} apps; pass the id:\n${matches.map((a) => `  ${a.id}  ${a.name}`).join("\n")}`);
}

/** This repo is public: real player data must never be written inside it. */
export function assertOutsideRepo(dir: string, repoRoot: string): void {
  const rel = relative(repoRoot, dir);
  const inside = rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  if (inside) {
    throw new Error(`Refusing to write AppMetrica data to ${dir}: it is inside this repo, which is public. Pick a folder outside it.`);
  }
}

export function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(seconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}
