import express from "express";
import { loadAdjustExport } from "@daemon-tools/roas-forecast";
import type { ExportStore } from "./store.js";

export interface AppOptions {
  /** The forecast page, built to read and save its export at `api/export`. */
  roasPage: string;
  roasExports: ExportStore;
  /** Largest accepted upload, in bytes. The page itself refuses files over 15 MB. */
  maxUpload?: number;
}

const ROAS = "/roas-forecast";

/**
 * There is no sign-in: anyone with a page's address can open it and upload. The root answers 404
 * and every response asks search engines to stay out, so the address isn't handed out, but that is
 * all the protection there is.
 */
export function createApp({ roasPage, roasExports, maxUpload = 20 * 1024 * 1024 }: AppOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Without it Express treats /roas-forecast and /roas-forecast/ as one path, and the redirect below would loop.
  app.enable("strict routing");
  // Caddy, inside the Docker network, is the only client: req.ip is then the visitor it forwards.
  app.set("trust proxy", "uniquelocal");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // The page finds its API at `api/export` relative to itself, which needs the trailing slash.
  app.get(ROAS, (_req, res) => res.redirect(301, `${ROAS}/`));
  app.get(`${ROAS}/`, (_req, res) => {
    res.set("Cache-Control", "no-cache").type("html").send(roasPage);
  });

  app.get(`${ROAS}/api/export`, async (_req, res) => {
    try {
      const latest = await roasExports.latest();
      res.set("Cache-Control", "no-store");
      if (!latest) {
        res.status(204).end();
        return;
      }
      res.json({ name: latest.name, uploadedAt: latest.uploadedAt, csv: latest.csv });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post(`${ROAS}/api/export`, express.text({ type: "text/csv", limit: maxUpload }), async (req, res) => {
    try {
      if (typeof req.body !== "string") {
        res.status(415).json({ error: "Send the export as text/csv." });
        return;
      }
      const name = fileName(req.get("x-file-name"));
      // The same reader the page uses, so the server never keeps a file the page cannot open.
      const loaded = loadAdjustExport(req.body, name);
      if (!loaded.ok) {
        res.status(422).json({
          error: loaded.empty
            ? `${name} has no rows with an install date.`
            : `${name} has no ${loaded.schema.missing.join(", ")} column. Export the Adjust report grouped by day, with installs, cost, roas_dN and retention_rate_dN.`,
        });
        return;
      }
      const info = await roasExports.save(name, req.body, loaded.cohorts.length);
      console.log(`roas-forecast: ${req.ip} uploaded ${info.name} (${info.rows} rows) as ${info.id}`);
      res.status(201).json({ name: info.name, uploadedAt: info.uploadedAt });
    } catch (err) {
      fail(res, err);
    }
  });

  // Body-parser errors (an upload over the limit, a bad charset) arrive here with their status.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status === 413) {
      res.status(413).json({ error: `The export is over ${Math.round(maxUpload / 1024 / 1024)} MB.` });
      return;
    }
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    fail(res, err);
  });

  return app;
}

/** The name as shown on the page and kept for the export date: no folders, no control characters. */
export function fileName(raw: string | undefined): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded: use it as sent.
  }
  name = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
  return name || "export.csv";
}

function fail(res: express.Response, err: unknown) {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong on the server." });
}
