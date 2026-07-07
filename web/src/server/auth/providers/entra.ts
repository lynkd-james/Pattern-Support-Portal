// =============================================================================
// Microsoft Entra ID adapter (Stage 8b).
//
// Composes the msal protocol plumbing (msal.ts) with the pure claim
// normaliser (entraClaims.ts) behind the provider-neutral adapter contract.
// Emits only AuthenticatedIdentity / IdentityDeny — Entra claim vocabulary
// stays inside this directory. Behaviour is byte-for-byte the Stage 8a Entra
// flow; this is an extraction, not a change.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("auth/providers/entra.ts is server-only.");
}

import type { IdentityProviderAdapter } from "../provider";
import { buildAuthCodeUrl, redeemAuthCode } from "./msal";
import { validateEntraClaims } from "./entraClaims";

export const entraAdapter: IdentityProviderAdapter = {
  provider: "entra",

  buildAuthUrl(flow) {
    return buildAuthCodeUrl(flow);
  },

  async redeemCode(params) {
    const result = await redeemAuthCode(params);
    return (result?.idTokenClaims as Record<string, unknown> | undefined) ?? null;
  },

  validateClaims(raw, expectedNonce) {
    return validateEntraClaims(raw, expectedNonce);
  },
};
