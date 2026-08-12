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
    let reason = token ? "unknown_key" : "no_token";
    let email: string | undefined;

    // Only try OIDC on something shaped like a JWT. Otherwise a mistyped API key gets reported
    // as a malformed token, which sends whoever reads the log looking at the wrong tier.
    const looksLikeJwt = token.split(".").length === 3;
    if (!identity && token && looksLikeJwt && options.verifyOidc) {
      const result = await options.verifyOidc(token);
      if (!result.ok) {
        reason = result.reason;
      } else {
        email = result.user.email;
        // A valid token still only gets in if this tenant lists the email. Compare
        // case-insensitively: the token's address is normalised, a hand-edited YAML entry isn't.
        const allowed = tenant.allow_emails.some((e) => e.toLowerCase() === email);
        if (allowed) identity = email;
        else reason = "not_allowlisted";
      }
    }

    if (!identity) {
      void audit.write({ event: "auth_denied", tenant: tenant.id, identity: null, reason, email });
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
