import { BigQuery } from "@google-cloud/bigquery";

export interface BigQueryConfig {
  projectId: string;
  serviceAccountPath: string;
  // Dataset location, e.g. "me-central1". Required for single-region datasets: BigQuery defaults
  // to US and fails with a "not found" that reads like a permissions problem, not a region one.
  location: string;
}

export interface QueryOptions {
  // Named parameters (@name in the SQL). Always use these for anything caller-supplied —
  // MCP tool arguments reach this layer directly.
  params?: Record<string, unknown>;
  // Refuses to run if the query would scan more than this. Crashlytics sessions tables get large,
  // and an unbounded scan is billed by bytes read.
  maxBytesBilled?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

export class BigQueryClient {
  private readonly bq: BigQuery;

  constructor(private readonly config: BigQueryConfig) {
    this.bq = new BigQuery({
      projectId: config.projectId,
      keyFilename: config.serviceAccountPath,
      location: config.location,
    });
  }

  async query<T = Record<string, unknown>>(sql: string, options: QueryOptions = {}): Promise<T[]> {
    const [rows] = await this.bq.query({
      query: sql,
      location: this.config.location,
      params: options.params,
      maximumBytesBilled: String(options.maxBytesBilled ?? DEFAULT_MAX_BYTES),
    });
    return rows as T[];
  }

  // Crashlytics creates a table per app only once data arrives, so "which tables exist" is a
  // real question a tool needs to answer rather than assume.
  async listTables(datasetId: string): Promise<string[]> {
    const [tables] = await this.bq.dataset(datasetId).getTables();
    return tables.map((t) => t.id ?? "").filter(Boolean);
  }
}
