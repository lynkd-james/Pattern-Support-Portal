// =============================================================================
// Microsoft Entra ID adapter (Stage 8b; factory-ised Stage 10a).
//
// Composes an Entra OIDC client (msal.ts — one per app registration) with the
// pure claim normaliser (entraClaims.ts) behind the provider-neutral adapter
// contract. Emits only AuthenticatedIdentity / IdentityDeny — Entra claim
// vocabulary stays inside this directory. `entraAdapter` is the customer app;
// `makeEntraAdapter` lets other realms (admin, Stage 10a) build an adapter over
// a different app registration while reusing the identical claim validation.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("auth/providers/entra.ts is server-only.");
}

import type { IdentityProviderAdapter } from "../provider";
import { customerEntraClient, type EntraClient } from "./msal";
import { validateEntraClaims } from "./entraClaims";

/** Build an Entra adapter over a specific app-registration client. */
export function makeEntraAdapter(client: EntraClient): IdentityProviderAdapter {
  return {
    provider: "entra",
    buildAuthUrl(flow) {
      return client.buildAuthCodeUrl(flow);
    },
    async redeemCode(params) {
      const result = await client.redeemAuthCode(params);
      return (result?.idTokenClaims as Record<string, unknown> | undefined) ?? null;
    },
    validateClaims(raw, expectedNonce) {
      return validateEntraClaims(raw, expectedNonce);
    },
  };
}

/** Customer multi-tenant Entra adapter (unchanged behaviour). */
export const entraAdapter: IdentityProviderAdapter = makeEntraAdapter(customerEntraClient);
