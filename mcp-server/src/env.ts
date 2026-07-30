export const env = {
  port: Number(process.env.PORT ?? 3000),
  configPath: process.env.CONFIG_PATH ?? "../config/tenants.yaml",
  auditLogPath: process.env.AUDIT_LOG_PATH ?? "../audit/audit.jsonl",
};
