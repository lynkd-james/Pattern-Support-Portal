// =============================================================================
// Google Workspace adapter (Stage 8c).
//
// Composes the OIDC plumbing (googleOidc.ts: discovery, PKCE code exchange,
// JWKS/aud/exp verification) with the pure claim normaliser (googleClaims.ts)
// behind the provider-neutral adapter contract. Emits only
// AuthenticatedIdentity / IdentityDeny — Google claim vocabulary stays inside
// this directory.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("auth/providers/google.ts is server-only.");
}

import type { IdentityProviderAdapter } from "../provider";
import { buildGoogleAuthUrl, redeemGoogleCode } from "./googleOidc";
import { validateGoogleClaims } from "./googleClaims";

export const googleAdapter: IdentityProviderAdapter = {
  provider: "google",

  buildAuthUrl(flow) {
    return buildGoogleAuthUrl(flow);
  },

  redeemCode(params) {
    return redeemGoogleCode(params);
  },

  validateClaims(raw, expectedNonce) {
    return validateGoogleClaims(raw, expectedNonce);
  },
};
