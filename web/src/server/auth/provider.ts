// =============================================================================
// Identity-provider adapter contract + registry (Stage 8b).
//
// Adapters are PURE CLAIM NORMALISERS plus protocol mechanics: they build the
// authorize URL, redeem the code over the back-channel, and validate raw
// claims into the provider-neutral AuthenticatedIdentity (or a typed
// IdentityDeny). They expose FACTS, never policy — provider-specific
// requirements live in policy.ts. Provider claim vocabulary must not leak
// beyond ./providers/. See docs/identity-providers.md §4.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("auth/provider.ts is server-only.");
}

import type {
  AuthenticatedIdentity,
  IdentityDeny,
  IdentityProviderId,
} from "./identity";
import { entraAdapter } from "./providers/entra";

export interface IdentityProviderAdapter {
  readonly provider: IdentityProviderId;
  /** Authorize-endpoint redirect for the sign-in flow. */
  buildAuthUrl(flow: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string>;
  /** Back-channel code exchange (the trust anchor); returns raw ID-token claims. */
  redeemCode(params: {
    code: string;
    codeVerifier: string;
  }): Promise<Record<string, unknown> | null>;
  /** Pure claim normalisation into the neutral domain object. */
  validateClaims(
    raw: Record<string, unknown>,
    expectedNonce: string
  ): AuthenticatedIdentity | IdentityDeny;
}

/** Registry. Google arrives in Stage 8c; requesting it now is a config error. */
export function getAdapter(provider: IdentityProviderId): IdentityProviderAdapter {
  if (provider === "entra") return entraAdapter;
  throw new Error(
    `Identity provider "${provider}" is not implemented yet (arrives in Stage 8c).`
  );
}
