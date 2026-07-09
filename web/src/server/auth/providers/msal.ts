// =============================================================================
// MSAL confidential-client wrapper (server-only; Entra adapter plumbing).
//
// Authorization-code flow + PKCE. The ID token's trust anchor is the
// authenticated BACK-CHANNEL TLS exchange with the token endpoint during
// acquireTokenByCode (the token is received from Microsoft directly, never
// from the browser) — not local signature validation. Claim normalisation
// lives in entraClaims.ts (pure); this module is protocol mechanics only.
// response_mode=query keeps the round-trip a top-level GET so SameSite=Lax
// cookies are sent on the redirect back. Entra tokens are used at login only
// and never stored.
//
// Stage 10a: generalised into a per-app factory so multiple Entra app
// registrations coexist — the customer multi-tenant app AND the separate
// single-tenant ADMIN app — each with its own client id/secret, authority and
// redirect path. The customer client (requirePortalAuth + /api/auth/callback,
// 'organizations' authority) is unchanged in behaviour.
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

export interface EntraAppConfig {
  clientId: string;
  clientSecret: string;
  authority: string;
  redirectUri: string;
}

/** A configured Entra OIDC client (one per app registration). */
export interface EntraClient {
  buildAuthCodeUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string>;
  redeemAuthCode(params: {
    code: string;
    codeVerifier: string;
  }): Promise<AuthenticationResult | null>;
}

/** Build a cached Entra client for a given app registration. */
export function makeEntraClient(configure: () => EntraAppConfig): EntraClient {
  let cca: ConfidentialClientApplication | null = null;
  let redirectUri = "";
  const app = () => {
    const cfg = configure();
    if (!cca) {
      cca = new ConfidentialClientApplication({
        auth: {
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
          authority: cfg.authority,
        },
      });
      redirectUri = cfg.redirectUri;
    }
    return cca;
  };
  return {
    buildAuthCodeUrl(params) {
      const a = app();
      return a.getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri,
        responseMode: ResponseMode.QUERY,
        state: params.state,
        nonce: params.nonce,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: "S256",
      });
    },
    redeemAuthCode(params) {
      const a = app();
      return a.acquireTokenByCode({
        scopes: SCOPES,
        redirectUri,
        code: params.code,
        codeVerifier: params.codeVerifier,
      });
    },
  };
}

// Customer multi-tenant app (unchanged behaviour: 'organizations' authority,
// /api/auth/callback).
export const customerEntraClient = makeEntraClient(() => {
  const cfg = requirePortalAuth();
  return {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    authority: cfg.authority,
    redirectUri: `${cfg.baseUrl}${REDIRECT_PATH}`,
  };
});
