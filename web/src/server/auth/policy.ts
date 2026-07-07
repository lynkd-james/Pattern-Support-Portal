// =============================================================================
// Provider policy layer (Stage 8b, pure, centralised).
//
// Provider-specific authentication REQUIREMENTS live here, beside the decision
// engine — never inside the adapters, which are pure claim normalisers
// emitting facts. Business rules stay in one reviewable place.
// See docs/identity-providers.md §4.
// =============================================================================

import type { IdentityProviderId } from "./identity";

export type EmailBootstrapTrust =
  /**
   * Deny only when the provider POSITIVELY asserts unverified; tolerate an
   * absent signal. Used where emission is tenant-config-dependent and
   * namespace pinning is the primary control (Entra xms_edov).
   */
  | "deny-only-if-false"
  /**
   * Require an explicit true; absence or false both deny. Used where the
   * signal is a standard claim on every token (Google email_verified).
   */
  | "require-true";

export interface ProviderPolicy {
  emailBootstrapTrust: EmailBootstrapTrust;
}

export const PROVIDER_POLICIES: Record<IdentityProviderId, ProviderPolicy> = {
  entra: { emailBootstrapTrust: "deny-only-if-false" },
  google: { emailBootstrapTrust: "require-true" },
};

export function policyFor(provider: IdentityProviderId): ProviderPolicy {
  return PROVIDER_POLICIES[provider];
}
