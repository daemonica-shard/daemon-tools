import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { TenantConfig } from "./tenants.js";
import type { AuditLog } from "./audit.js";

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

// Resolves the caller's identity (key name) or rejects with 401.
export function bearerAuth(tenant: TenantConfig, audit: AuditLog) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const identity = token ? findKeyName(tenant, token) : null;
    if (!identity) {
      void audit.write({ event: "auth_denied", tenant: tenant.id, identity: null });
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="daemon-tools"')
        .json({ error: "unauthorized" });
      return;
    }
    res.locals.identity = identity;
    next();
  };
}
