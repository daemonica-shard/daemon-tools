import { stat } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";

export interface DayFile {
  day: string;
  path: string;
}

export interface Converter {
  /**
   * Converts one CSV into one Parquet file per day: the rows whose `dayColumn` starts with that
   * yyyy-mm-dd. Returns each file's row count, in the order of `files`. A row on none of the days
   * is an error. A 0-byte CSV gives empty files with `fields` as columns.
   */
  split(csvPath: string, dayColumn: string, files: DayFile[], fields: readonly string[]): Promise<number[]>;
  close(): void;
}

const NAME_RE = /^[a-z0-9_]+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const quote = (path: string) => `'${path.replace(/'/g, "''")}'`;

/**
 * Parquet through an in-process DuckDB. A day's CSV shrinks about 50× (273 MB of impressions to
 * 6 MB), and queries read only the columns they use.
 *
 * Every column stays text (VARCHAR), exactly as AppMetrica sent it. Type guessing could rewrite
 * values (os_version 14.10 read as the number 14.1) or fail on one odd row, so casts are left to
 * queries. The CSV dialect is spelled out (RFC 4180, as AppMetrica writes it) rather than sniffed
 * per file.
 */
export function duckdbConverter(): Converter {
  let instance: Promise<DuckDBInstance> | undefined;
  let closed = false;
  return {
    async split(csvPath, dayColumn, files, fields) {
      if (closed) throw new Error("converter is closed");
      for (const name of [dayColumn, ...fields]) if (!NAME_RE.test(name)) throw new Error(`Invalid column name: ${name}`);
      for (const { day } of files) if (!DAY_RE.test(day)) throw new Error(`Invalid day: ${day}`);
      if (!fields.includes(dayColumn)) throw new Error(`The export must include ${dayColumn} to be split into days`);

      instance ??= DuckDBInstance.create(":memory:");
      const connection = await (await instance).connect();
      try {
        const { size } = await stat(csvPath);
        const source =
          size === 0
            ? `SELECT ${fields.map((f) => `NULL::VARCHAR AS "${f}"`).join(", ")} WHERE false`
            : `FROM read_csv(${quote(csvPath)}, header = true, all_varchar = true, delim = ',', quote = '"', escape = '"')`;
        await connection.run(`CREATE TEMP TABLE export AS ${source}`);
        const counts: number[] = [];
        for (const { day, path } of files) {
          const result = await connection.runAndReadAll(
            `COPY (FROM export WHERE substr("${dayColumn}", 1, 10) = '${day}') TO ${quote(path)} (FORMAT parquet, COMPRESSION zstd)`,
          );
          counts.push(Number(result.getRows()[0]?.[0] ?? 0));
        }
        const total = Number((await connection.runAndReadAll("SELECT count(*) FROM export")).getRows()[0][0]);
        const placed = counts.reduce((a, b) => a + b, 0);
        if (placed !== total) {
          throw new Error(`${total - placed} of ${total} rows arrived on days outside the export's range`);
        }
        return counts;
      } finally {
        connection.closeSync();
      }
    },
    close() {
      closed = true;
      instance?.then((db) => db.closeSync()).catch(() => {});
    },
  };
}
