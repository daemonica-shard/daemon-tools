#!/usr/bin/env node
// Builds the single-file forecast page: the library from src/ (transpiled in memory, so no tsc run
// is needed first) inlined into page/template.html, optionally with an Adjust export bundled in.
//
//   pnpm page                              dist/roas-forecast.html: manual entry, or load a CSV in the page
//   pnpm page --csv export.csv             the same page with that export bundled
//   pnpm page --csv export.csv --out x.html
//
// This repo is public. A page built with --csv carries spend, ROAS and campaign names, so it may
// only be written to a dist/ folder (gitignored) or outside the repo.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(root, "..", "..");
const MODULES = ["model", "adjust", "index"];

/** The library as a classic script that defines a global `RoasForecast`. */
export function bundleLibrary() {
  const defs = MODULES.map((name) => {
    const source = readFileSync(resolve(root, "src", `${name}.ts`), "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: `${name}.ts`,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    });
    return `  defs[${JSON.stringify(name)}] = function (module, exports, require) {\n${outputText}\n  };`;
  });
  return [
    "var RoasForecast = (function () {",
    "  var defs = {}, cache = {};",
    "  function req(id) {",
    "    var key = id.replace(/^\\.\\//, '').replace(/\\.js$/, '');",
    "    if (!defs[key]) throw new Error('Unknown module ' + id);",
    "    if (!cache[key]) { cache[key] = { exports: {} }; defs[key](cache[key], cache[key].exports, req); }",
    "    return cache[key].exports;",
    "  }",
    ...defs,
    "  return req('index');",
    "})();",
  ].join("\n");
}

/** Evaluates the bundle outside a browser, e.g. to read a CSV with the same parser the page uses. */
export function loadBundle(bundle = bundleLibrary()) {
  return vm.runInNewContext(`${bundle}\nRoasForecast;`, {});
}

// Only the columns the page reads, in their original order.
function trimExport(lib, text, name) {
  const loaded = lib.loadAdjustExport(text, name);
  if (!loaded.ok) {
    throw new Error(
      loaded.empty
        ? `${name} has no rows with an install date.`
        : `${name} is missing ${loaded.schema.missing.join(", ")}. Export the Adjust report grouped by day, with installs, cost, roas_dN and retention_rate_dN.`,
    );
  }
  const s = loaded.schema;
  const keep = new Set([
    s.dateCol,
    s.installsCol,
    s.costCol,
    ...s.dims,
    ...s.retention.map((c) => c.col),
    ...s.roas.map((c) => c.col),
    ...s.cohortRevenue.flatMap((c) => c.cols),
    ...s.eventRevenue,
  ]);
  const parsed = lib.parseCsv(text);
  const columns = parsed.columns.filter((c) => keep.has(c));
  const quote = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = [columns.join(",")]
    .concat(parsed.records.map((r) => columns.map((c) => quote(r[c] ?? "")).join(",")))
    .join("\n");
  return { csv, rows: parsed.records.length, columns: columns.length };
}

/**
 * The page as a string. `csv` is optional: { text, name }. `host` is for a server that hosts the
 * page: { api } makes it read the shared export from that URL and save uploads there.
 */
export function buildPage({ csv, host } = {}) {
  const bundle = bundleLibrary();
  let bundled = { csv: "", rows: 0, columns: 0 };
  if (csv) bundled = trimExport(loadBundle(bundle), csv.text, csv.name);
  if (/<\/script/i.test(bundled.csv)) throw new Error("The export contains a closing script tag.");
  const escapeAttr = (v) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  let html = readFileSync(resolve(root, "page", "template.html"), "utf8");
  const swap = (token, value) => {
    if (!html.includes(token)) throw new Error(`template.html has no ${token}`);
    html = html.split(token).join(value);
  };
  swap("/*@LIBRARY@*/", bundle);
  swap("@BUNDLED_NAME@", csv ? escapeAttr(csv.name) : "");
  swap("@BUNDLED_CSV@", bundled.csv);
  // `<` escaped so no value can close the script element it sits in.
  swap("@HOST_CONFIG@", JSON.stringify(host ?? {}).replace(/</g, "\\u003c"));
  return { html, rows: bundled.rows, columns: bundled.columns };
}

function parseArgs(argv) {
  const args = { csv: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--csv") args.csv = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--") continue;
    else throw new Error(`Unknown argument ${a}. Usage: build-page.mjs [--csv export.csv] [--out page.html]`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(args.out ?? resolve(root, "dist", "roas-forecast.html"));
  if (args.csv) {
    const inRepo = out.startsWith(repoRoot + sep);
    const inDist = relative(repoRoot, out).split(sep).includes("dist");
    if (inRepo && !inDist) {
      throw new Error(`Refusing to write a page with bundled data to ${out}: this repo is public. Use a dist/ folder or a path outside the repo.`);
    }
  }
  const csvPath = args.csv ? resolve(args.csv) : null;
  const { html, rows, columns } = buildPage({
    csv: csvPath ? { text: readFileSync(csvPath, "utf8"), name: basename(csvPath) } : undefined,
  });
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  const size = `${(html.length / 1024).toFixed(0)} KB`;
  console.log(csvPath ? `Wrote ${out} (${size}) with ${rows} rows × ${columns} columns of ${basename(csvPath)}.` : `Wrote ${out} (${size}), no data bundled.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
