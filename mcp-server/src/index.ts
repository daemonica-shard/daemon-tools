import { env } from "./env.js";
import { loadTenants } from "./tenants.js";
import { AuditLog } from "./audit.js";
import { createApp } from "./app.js";

const tenants = loadTenants(env.configPath);
const audit = new AuditLog(env.auditLogPath);
const app = createApp(tenants, audit, {
  oidcIssuer: env.oidcIssuer,
  publicUrl: env.publicUrl,
});

app.listen(env.port, () => {
  console.log(`mcp-server listening on :${env.port}`);
  const oidc = env.oidcIssuer && env.publicUrl ? env.oidcIssuer : "disabled (API keys only)";
  console.log(`  oidc: ${oidc}`);
  for (const tenant of tenants) {
    console.log(`  /${tenant.id}/mcp  (${tenant.display}, tools: ${Object.keys(tenant.tools).join(", ") || "none"})`);
  }
});
