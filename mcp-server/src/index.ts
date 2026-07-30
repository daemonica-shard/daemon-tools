import { env } from "./env.js";
import { loadTenants } from "./tenants.js";
import { AuditLog } from "./audit.js";
import { createApp } from "./app.js";

const tenants = loadTenants(env.configPath);
const audit = new AuditLog(env.auditLogPath);
const app = createApp(tenants, audit);

app.listen(env.port, () => {
  console.log(`mcp-server listening on :${env.port}`);
  for (const tenant of tenants) {
    console.log(`  /${tenant.id}/mcp  (${tenant.display}, tools: ${Object.keys(tenant.tools).join(", ") || "none"})`);
  }
});
