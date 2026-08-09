import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { TenantConfig } from "./tenants.js";
import type { AuditLog } from "./audit.js";
import type { OidcVerifier } from "./oidc.js";

export function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function findKeyName(tenant: TenantConfig, token: string): string | null {
  const hash = Buffer.from(sha256(token), "hex");
  for (const [name, keyHash] of Object.entries(tenant.keys)) {
    if (timingSafeEqual(hash, Buffer.from(keyHash, "hex"))) return name;
  }
  return null;
}

export interface AuthOptions {
  verifyOidc?: OidcVerifier;
  // Advertised in WWW-Authenticate on 401 so MCP clients can discover the auth server.
  resourceMetadataUrl?: string;
}

// Two credential types resolve to one identity string, which is what the audit log records:
//   - static API key  → the key's name from tenants.yaml   (engineers, CI)
//   - OIDC access token → the caller's email               (designers, via Google sign-in)
export function bearerAuth(tenant: TenantConfig, audit: AuditLog, options: AuthOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

    let identity: string | null = token ? findKeyName(tenant, token) : null;

    // A JWT can never match a key hash, so trying OIDC second costs nothing.
    if (!identity && token && options.verifyOidc) {
      const user = await options.verifyOidc(token);
      // A valid token still only gets in if this tenant lists the email.
      if (user && tenant.allow_emails.includes(user.email)) identity = user.email;
    }

    if (!identity) {
      void audit.write({ event: "auth_denied", tenant: tenant.id, identity: null });
      const challenge = options.resourceMetadataUrl
        ? `Bearer realm="daemon-tools", resource_metadata="${options.resourceMetadataUrl}"`
        : 'Bearer realm="daemon-tools"';
      res.status(401).set("WWW-Authenticate", challenge).json({ error: "unauthorized" });
      return;
    }

    res.locals.identity = identity;
    next();
  };
}
