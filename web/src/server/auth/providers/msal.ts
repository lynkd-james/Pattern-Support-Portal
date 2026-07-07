// =============================================================================
// MSAL confidential-client wrapper (server-only; Entra adapter plumbing).
//
// Authorization-code flow + PKCE against the multi-tenant `organizations`
// authority. The ID token's trust anchor is the authenticated BACK-CHANNEL TLS
// exchange with the token endpoint during acquireTokenByCode (the token is
// received from Microsoft directly, never from the browser) — not local
// signature validation. Claim normalisation lives in entraClaims.ts (pure);
// this module is protocol mechanics only. response_mode=query keeps the
// round-trip a top-level GET so SameSite=Lax cookies are sent on the redirect
// back. Entra tokens are used at login only and never stored.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("auth/providers/msal.ts is server-only.");
}

import {
  ConfidentialClientApplication,
  ResponseMode,
  type AuthenticationResult,
} from "@azure/msal-node";
import { requirePortalAuth } from "../../env";

export const REDIRECT_PATH = "/api/auth/callback";
const SCOPES = ["openid", "profile", "email"];

let cca: ConfidentialClientApplication | null = null;

function getApp(): { app: ConfidentialClientApplication; redirectUri: string } {
  const cfg = requirePortalAuth();
  if (!cca) {
    cca = new ConfidentialClientApplication({
      auth: {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        authority: cfg.authority,
      },
    });
  }
  return { app: cca, redirectUri: `${cfg.baseUrl}${REDIRECT_PATH}` };
}

/** Authorization URL for the sign-in redirect. */
export function buildAuthCodeUrl(params: {
  state: string;
  nonce: string;
  codeChallenge: string;
}): Promise<string> {
  const { app, redirectUri } = getApp();
  return app.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri,
    responseMode: ResponseMode.QUERY,
    state: params.state,
    nonce: params.nonce,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: "S256",
  });
}

/** Exchange the authorization code over the back-channel (the trust anchor). */
export function redeemAuthCode(params: {
  code: string;
  codeVerifier: string;
}): Promise<AuthenticationResult | null> {
  const { app, redirectUri } = getApp();
  return app.acquireTokenByCode({
    scopes: SCOPES,
    redirectUri,
    code: params.code,
    codeVerifier: params.codeVerifier,
  });
}
