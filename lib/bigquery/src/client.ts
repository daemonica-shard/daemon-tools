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

export interface TableField {
  name: string;
  type: string;
  mode?: string;
}

interface RawField {
  name?: string;
  type?: string;
  mode?: string;
  fields?: RawField[];
}

// Crashlytics nests heavily (application.display_version, device.model). Flatten to dotted paths
// so the output reads the way the field would be written in a query.
function flattenFields(fields: RawField[], prefix = ""): TableField[] {
  return fields.flatMap((f) => {
    const name = prefix ? `${prefix}.${f.name}` : (f.name ?? "");
    const self: TableField = { name, type: f.type ?? "UNKNOWN", mode: f.mode };
    return f.fields?.length ? [self, ...flattenFields(f.fields, name)] : [self];
  });
}

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

  // Exposed as a tool rather than kept internal: the Crashlytics export's schema isn't fully
  // documented, so being able to ask the live table what it holds beats encoding assumptions.
  async describeTable(datasetId: string, tableId: string): Promise<TableField[]> {
    const [metadata] = await this.bq.dataset(datasetId).table(tableId).getMetadata();
    return flattenFields(metadata?.schema?.fields ?? []);
  }
}
