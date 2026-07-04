// =============================================================================
// Sign-in flow cookie (server-only, Stage 8a).
//
// Holds the per-flow secrets (CSRF state, ID-token nonce, PKCE verifier)
// between /api/auth/login and /api/auth/callback in a short-lived httpOnly
// cookie. SameSite=Lax + response_mode=query means the browser sends it on the
// top-level GET redirect back from Entra. The cookie is deleted the moment the
// callback reads it (single use).
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("auth/flow.ts is server-only.");
}

import { env } from "../env";
import type { FlowSecrets } from "./msal";

export const FLOW_COOKIE_MAX_AGE_S = 600; // 10 minutes to complete sign-in

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
      typeof p.state !== "string" ||
      typeof p.nonce !== "string" ||
      typeof p.codeVerifier !== "string"
    ) {
      return null;
    }
    return { state: p.state, nonce: p.nonce, codeVerifier: p.codeVerifier };
  } catch {
    return null;
  }
}
