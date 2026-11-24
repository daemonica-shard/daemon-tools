import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import { ExportStore } from "./store.js";

const port = Number(process.env.PORT ?? 3000);
// Uploads are real spend and revenue: locally this defaults to web/data, which git ignores.
const dataDir = process.env.DATA_DIR ?? "data";
const roasPage = readFileSync(new URL("./pages/roas-forecast.html", import.meta.url), "utf8");

const app = createApp({ roasPage, roasExports: new ExportStore(join(dataDir, "roas-forecast", "exports")) });

app.listen(port, () => {
  console.log(`web listening on :${port}, data in ${dataDir}`);
  console.log("  /roas-forecast/  ROAS payback forecast");
});
