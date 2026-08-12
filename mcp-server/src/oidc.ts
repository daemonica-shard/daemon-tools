import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface OidcUser {
  email: string;
  subject: string;
}

// Every rejection carries why. Without this, a bad signature, a stale issuer, a missing audience
// mapper and an unmapped email claim are indistinguishable in the audit log — which turns a
// misconfiguration into a bisect instead of a lookup.
export type OidcResult = { ok: true; user: OidcUser } | { ok: false; reason: string };

export type OidcVerifier = (token: string) => Promise<OidcResult>;

// jose reports failures by error code. `claim` separates the two that matter most in practice:
// iss means the realm or issuer URL moved; aud means the Audience mapper isn't reaching this host.
function reasonFor(err: unknown): string {
  const e = err as { code?: string; claim?: string };
  switch (e?.code) {
    case "ERR_JWT_EXPIRED":
      return "token_expired";
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return "bad_signature";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      if (e.claim === "aud") return "wrong_audience";
      if (e.claim === "iss") return "wrong_issuer";
      return `bad_claim_${e.claim ?? "unknown"}`;
    case "ERR_JWS_INVALID":
    case "ERR_JWT_INVALID":
      return "malformed_token";
    default:
      // Discovery and JWKS fetch failures land here: the provider being unreachable, rather than
      // the caller presenting something wrong.
      return "verification_failed";
  }
}

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

// Verifies an access token issued by the OIDC provider and returns the caller's email, or the
// reason it was rejected. The caller decides how to report it.
//
// `audience` must match this server's public URL. Keycloak does not implement the MCP
// spec's `resource` parameter, so audience binding comes from a client scope carrying an
// Audience mapper (see deploy/SETUP.md). Verifying it is what stops a token minted for
// another service in the same realm from being replayed here.
export function createOidcVerifier(issuer: string, audience: string): OidcVerifier {
  const jwks = jwksFor(issuer);
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, await jwks.get(), { issuer, audience });
      const email = typeof payload.email === "string" ? payload.email : null;
      // A valid token with no email means the provider isn't mapping the claim through — a
      // configuration problem at the IdP, not a bad caller.
      if (!email) return { ok: false, reason: "no_email_claim" };
      return { ok: true, user: { email: email.toLowerCase(), subject: String(payload.sub ?? "") } };
    } catch (err) {
      return { ok: false, reason: reasonFor(err) };
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
