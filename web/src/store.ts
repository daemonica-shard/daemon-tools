import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ExportInfo {
  id: string;
  /** The uploaded file's name. The forecast reads the export date from it. */
  name: string;
  uploadedAt: string;
  bytes: number;
  rows: number;
}

/**
 * Uploaded exports, kept as uploaded: one CSV plus one JSON per upload, named by upload time so the
 * newest sorts last. Anyone can upload, so the folder can't grow without end: the newest `keep`
 * stay, and each upload deletes the ones before them.
 */
export class ExportStore {
  private seq = 0;

  constructor(
    private dir: string,
    private keep = 10,
  ) {}

  async save(name: string, csv: string, rows: number): Promise<ExportInfo> {
    await mkdir(this.dir, { recursive: true });
    const uploadedAt = new Date().toISOString();
    // The sequence orders two uploads made within the same millisecond.
    const id = `${uploadedAt.replace(/[:.]/g, "-")}-${String(this.seq++).padStart(6, "0")}-${randomBytes(3).toString("hex")}`;
    const info: ExportInfo = { id, name, uploadedAt, bytes: Buffer.byteLength(csv), rows };
    await writeFile(join(this.dir, `${id}.csv`), csv);
    // The JSON is what makes an upload visible, so it goes last and appears whole.
    const tmp = join(this.dir, `${id}.json.tmp`);
    await writeFile(tmp, JSON.stringify(info, null, 2));
    await rename(tmp, join(this.dir, `${id}.json`));
    await this.prune();
    return info;
  }

  async latest(): Promise<(ExportInfo & { csv: string }) | null> {
    const id = (await this.ids()).pop();
    if (!id) return null;
    const info = JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as ExportInfo;
    return { ...info, csv: await readFile(join(this.dir, `${id}.csv`), "utf8") };
  }

  /** Finished uploads, oldest first. */
  private async ids(): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  }

  private async prune() {
    const ids = await this.ids();
    for (const id of ids.slice(0, Math.max(0, ids.length - Math.max(1, this.keep)))) {
      // The JSON first: once it is gone, the upload is gone, whatever happens to the CSV.
      await rm(join(this.dir, `${id}.json`), { force: true });
      await rm(join(this.dir, `${id}.csv`), { force: true });
    }
  }
}
