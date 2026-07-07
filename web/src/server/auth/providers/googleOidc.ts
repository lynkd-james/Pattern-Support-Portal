// =============================================================================
// Google OIDC plumbing (server-only; Google adapter protocol mechanics).
//
// Discovery-driven (https://accounts.google.com/.well-known/openid-configuration,
// cached), authorization-code flow + PKCE (S256), response_type=code (top-level
// GET redirect back => SameSite=Lax cookies are sent). The ID token's trust
// anchor is the authenticated BACK-CHANNEL TLS exchange with Google's token
// endpoint (client secret authenticates us; the token never transits the
// browser) — identical to the Entra model. jose additionally verifies the JWT
// signature against Google's JWKS plus audience and expiry (belt-and-braces on
// top of the back-channel anchor). Claim-level checks (nonce / sub / hd / iss)
// live in googleClaims.ts (pure) so the denial ordering and surface match the
// Entra adapter exactly. Google tokens are used at login only and never stored.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("auth/providers/googleOidc.ts is server-only.");
}

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { requireGoogleAuth } from "../../env";

export const GOOGLE_REDIRECT_PATH = "/api/auth/google/callback";
const DISCOVERY_URL =
  "https://accounts.google.com/.well-known/openid-configuration";
const SCOPES = "openid email profile";
/** Discovery metadata changes rarely; re-fetch hourly. */
const DISCOVERY_TTL_MS = 3_600_000;

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: { doc: DiscoveryDoc; fetchedAt: number } | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUri: string | null = null;

async function getDiscovery(): Promise<DiscoveryDoc> {
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
    return discoveryCache.doc;
  }
  const res = await fetch(DISCOVERY_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Google OIDC discovery failed with ${res.status}`);
  }
  const doc = (await res.json()) as DiscoveryDoc;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("Google OIDC discovery document is missing required endpoints");
  }
  discoveryCache = { doc, fetchedAt: Date.now() };
  return doc;
}

/** Remote JWKS with jose's built-in HTTP caching; rebuilt if the uri changes. */
function getJwks(uri: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks || jwksUri !== uri) {
    jwks = createRemoteJWKSet(new URL(uri));
    jwksUri = uri;
  }
  return jwks;
}

/** Authorization URL for the sign-in redirect. */
export async function buildGoogleAuthUrl(params: {
  state: string;
  nonce: string;
  codeChallenge: string;
}): Promise<string> {
  const cfg = requireGoogleAuth();
  const { authorization_endpoint } = await getDiscovery();
  const u = new URL(authorization_endpoint);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", `${cfg.baseUrl}${GOOGLE_REDIRECT_PATH}`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", params.state);
  u.searchParams.set("nonce", params.nonce);
  u.searchParams.set("code_challenge", params.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/**
 * Back-channel code exchange + JWT verification. Returns the raw ID-token
 * claims; nonce / sub / hd / iss checks are the pure normaliser's job.
 * Signature (JWKS), audience (our client id) and expiry are verified here by
 * jose; failures throw and surface as retryable flow failures — the same
 * surface those failures have on the Entra/msal path.
 */
export async function redeemGoogleCode(params: {
  code: string;
  codeVerifier: string;
}): Promise<Record<string, unknown> | null> {
  const cfg = requireGoogleAuth();
  const { token_endpoint, jwks_uri } = await getDiscovery();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: `${cfg.baseUrl}${GOOGLE_REDIRECT_PATH}`,
    code_verifier: params.codeVerifier,
  });
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google token endpoint returned ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) return null;

  const { payload } = await jwtVerify(json.id_token, getJwks(jwks_uri), {
    audience: cfg.clientId,
    // issuer deliberately NOT enforced here: the iss check is a claim-level
    // rule in googleClaims.ts so its denial surface matches the Entra adapter.
  });
  return payload as JWTPayload as Record<string, unknown>;
}
