#!/usr/bin/env node
// Builds the pages the server hosts into dist/pages. They carry no data: a page reads the shared
// export from the server when it opens, from `api/export` next to itself.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPage } from "@daemon-tools/roas-forecast/scripts/build-page.mjs";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "pages");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "roas-forecast.html"), buildPage({ host: { api: "api/export" } }).html);
console.log(`Wrote ${out}/roas-forecast.html`);
