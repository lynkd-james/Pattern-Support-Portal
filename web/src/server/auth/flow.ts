// =============================================================================
// Sign-in flow cookie + per-flow secrets (server-only; provider-agnostic).
//
// Holds the per-flow secrets (CSRF state, ID-token nonce, PKCE verifier, and
// the PROVIDER the flow was started for) between a login route and its
// callback in a short-lived httpOnly cookie. SameSite=Lax + response_mode=query
// means the browser sends it on the top-level GET redirect back from the
// provider. The cookie is deleted the moment the callback reads it (single
// use), and each callback verifies the cookie's provider matches its own route
// (defence against cross-flow replay).
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("auth/flow.ts is server-only.");
}

import { createHash, randomBytes } from "node:crypto";
import { env } from "../env";
import type { IdentityProviderId } from "./identity";

export const FLOW_COOKIE_MAX_AGE_S = 600; // 10 minutes to complete sign-in

/** Which auth realm a flow belongs to (Stage 10a — realm isolation). */
export type AuthRealmName = "customer" | "admin";

export interface FlowSecrets {
  realm: AuthRealmName;
  provider: IdentityProviderId;
  state: string;
  nonce: string;
  codeVerifier: string;
}

const PROVIDER_IDS: ReadonlySet<string> = new Set(["entra", "google"]);
const REALM_NAMES: ReadonlySet<string> = new Set(["customer", "admin"]);

/** Fresh per-flow secrets: CSRF state, ID-token nonce, PKCE verifier+challenge (S256). */
export function newFlowSecrets(
  realm: AuthRealmName,
  provider: IdentityProviderId
): FlowSecrets & { codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return {
    realm,
    provider,
    state: randomBytes(16).toString("base64url"),
    nonce: randomBytes(16).toString("base64url"),
    codeVerifier,
    codeChallenge,
  };
}

/** Secure flag: only relaxed for an explicit http://localhost dev base URL. */
export function cookiesSecure(): boolean {
  return !(env.portalBaseUrl ?? "").startsWith("http://localhost");
}

export function serializeFlowSecrets(secrets: FlowSecrets): string {
  return Buffer.from(JSON.stringify(secrets), "utf8").toString("base64url");
}

export function parseFlowSecrets(cookieValue: string): FlowSecrets | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cookieValue, "base64url").toString("utf8")
    );
    if (parsed === null || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.realm !== "string" ||
      !REALM_NAMES.has(p.realm) ||
      typeof p.provider !== "string" ||
      !PROVIDER_IDS.has(p.provider) ||
      typeof p.state !== "string" ||
      typeof p.nonce !== "string" ||
      typeof p.codeVerifier !== "string"
    ) {
      return null;
    }
    return {
      realm: p.realm as AuthRealmName,
      provider: p.provider as IdentityProviderId,
      state: p.state,
      nonce: p.nonce,
      codeVerifier: p.codeVerifier,
    };
  } catch {
    return null;
  }
}
