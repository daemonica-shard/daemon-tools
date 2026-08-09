export const env = {
  port: Number(process.env.PORT ?? 3000),
  configPath: process.env.CONFIG_PATH ?? "../config/tenants.yaml",
  auditLogPath: process.env.AUDIT_LOG_PATH ?? "../audit/audit.jsonl",
  // OIDC (Keycloak) for the Google-sign-in tier. Both unset = tier disabled and only
  // static API keys are accepted, which is how the server ran before OAuth existed.
  oidcIssuer: process.env.OIDC_ISSUER ?? "",
  publicUrl: process.env.PUBLIC_URL ?? "",
};
