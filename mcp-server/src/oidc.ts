import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface OidcUser {
  email: string;
  subject: string;
}

export type OidcVerifier = (token: string) => Promise<OidcUser | null>;

// Discovery rather than a hardcoded certs path, so any OIDC provider works and key
// rotation is handled by jose's JWKS cache.
function jwksFor(issuer: string): { get: () => Promise<JWTVerifyGetKey> } {
  let cached: Promise<JWTVerifyGetKey> | null = null;
  return {
    get() {
      if (!cached) {
        cached = fetch(`${issuer}/.well-known/openid-configuration`)
          .then(async (res) => {
            if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
            const doc = (await res.json()) as { jwks_uri?: string };
            if (!doc.jwks_uri) throw new Error("OIDC discovery document has no jwks_uri");
            return createRemoteJWKSet(new URL(doc.jwks_uri));
          })
          // Don't cache a failure — the provider may just have been starting up.
          .catch((err) => {
            cached = null;
            throw err;
          });
      }
      return cached;
    },
  };
}

// Verifies an access token issued by the OIDC provider and returns the caller's email.
// Returns null for anything invalid: the caller decides how to report it.
export function createOidcVerifier(issuer: string): OidcVerifier {
  const jwks = jwksFor(issuer);
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, await jwks.get(), { issuer });
      const email = typeof payload.email === "string" ? payload.email : null;
      if (!email) return null;
      return { email: email.toLowerCase(), subject: String(payload.sub ?? "") };
    } catch {
      return null;
    }
  };
}

// RFC 9728. Points clients at the authorization server when they get a 401, which is
// what triggers the browser sign-in flow in Claude Desktop / claude.ai.
export function protectedResourceMetadata(publicUrl: string, issuer: string) {
  return {
    resource: publicUrl,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email", "profile"],
  };
}
