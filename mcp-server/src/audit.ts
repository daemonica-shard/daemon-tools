import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditEvent {
  event: "tool_call" | "auth_denied";
  tenant: string;
  identity: string | null;
  tool?: string;
  args?: unknown;
}

export class AuditLog {
  private ready: Promise<unknown>;

  constructor(private path: string) {
    this.ready = mkdir(dirname(path), { recursive: true });
  }

  async write(event: AuditEvent): Promise<void> {
    await this.ready;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    // Serialized through `ready` so concurrent writes can't interleave lines.
    this.ready = this.ready.then(() => appendFile(this.path, line + "\n"));
    await this.ready;
  }
}
