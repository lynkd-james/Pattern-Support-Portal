// =============================================================================
// Provider-neutral identity domain + login decision (Stage 8b, pure).
// No DB or network here, mirroring sync/resolve.ts, so every branch is
// unit-testable. See docs/identity-providers.md.
//
// Trust model: the identity provider authenticates; the portal DB authorises.
// Every identity is the triple (identity_provider, issuer_namespace,
// subject_identifier). The namespace is PINNED at provisioning; the subject is
// BOUND at first login; the triple is the sole login key thereafter. Email is
// only ever a bootstrap correlator for unbound rows, WITHIN the pinned
// namespace, gated by the provider policy (policy.ts). Mutable identifiers are
// never read for identity.
//
// Provider claim vocabulary (tid/oid/hd/sub/...) never appears in this module —
// it is confined to the adapters in ./providers/.
// =============================================================================

import { createHash } from "node:crypto";
import type { ProviderPolicy } from "./policy";

export type IdentityProviderId = "entra" | "google";

// ---- the domain object every adapter normalises into --------------------------

/**
 * Factual attributes of a successfully validated authentication — no policy
 * decisions. Pure data (no methods, no adapter back-references) so the
 * decision-layer test suite constructs it literally.
 */
export interface AuthenticatedIdentity {
  provider: IdentityProviderId;
  /** Fact: the token's organisational-namespace claim (Entra tid / Google hd). */
  issuerNamespace: string;
  /** Fact: the token's immutable subject (Entra oid / Google sub). */
  subjectIdentifier: string;
  /** Fact: lowercased email claim, or null when the token carries none. */
  email: string | null;
  /** Fact: the provider's verification signal AS OBSERVED (undefined = not emitted). */
  emailVerified: boolean | undefined;
  /** Informational ONLY — never persisted, never an authorization input. */
  displayName: string | null;
}

export type ClaimDenyReason =
  | "NONCE_MISMATCH"
  | "MISSING_NAMESPACE"
  | "MISSING_SUBJECT"
  | "ISSUER_MISMATCH";

/**
 * Typed claim-validation failure. Carries its own best-effort telemetry so raw
 * claims never leak out of an adapter just to build a denial audit row.
 */
export interface IdentityDeny {
  reason: ClaimDenyReason;
  issuerNamespace: string | null;
  email: string | null;
}

/** Narrowing helper for the adapter result union. */
export function isIdentityDeny(
  r: AuthenticatedIdentity | IdentityDeny
): r is IdentityDeny {
  return "reason" in r;
}

// ---- login decision -------------------------------------------------------------

/** portal_users row shape the decision needs (joined with its account). */
export interface CandidateUser {
  id: string;
  accountId: string;
  identityProvider: IdentityProviderId;
  issuerNamespace: string | null;
  subjectIdentifier: string | null;
  userActive: boolean;
  accountActive: boolean;
}

export type LoginDenyReason =
  | ClaimDenyReason
  | "NO_EMAIL_CLAIM" // unbound identity and the token carries no email claim
  | "NOT_PROVISIONED" // no portal user matches (bound or by email)
  | "PROVIDER_MISMATCH" // email matched a row provisioned for a different provider
  | "NAMESPACE_NOT_CAPTURED" // email matched, but the row has no provisioned namespace yet
  | "NAMESPACE_MISMATCH" // email matched, but token namespace != provisioned namespace
  | "EMAIL_ALREADY_BOUND" // email matched a row already bound to a DIFFERENT subject
  | "EMAIL_NOT_VERIFIED" // provider policy rejected the email-verification signal
  | "USER_INACTIVE"
  | "ACCOUNT_INACTIVE";

export type LoginDecision =
  | { kind: "admit"; userId: string; accountId: string; bind: boolean }
  | { kind: "deny"; reason: LoginDenyReason };

export interface LoginInput {
  identity: AuthenticatedIdentity;
  /** Centralised per-provider requirements (policy.ts) — resolved by the caller. */
  policy: ProviderPolicy;
  /** Row matched by (provider, namespace, subject), any active state. */
  boundUser: CandidateUser | null;
  /** Row matched by email ONLY (unique key), fetched when no bound row exists. */
  emailUser: CandidateUser | null;
}

const deny = (reason: LoginDenyReason): LoginDecision => ({ kind: "deny", reason });

function activeCheck(u: CandidateUser): LoginDenyReason | null {
  if (!u.userActive) return "USER_INACTIVE";
  if (!u.accountActive) return "ACCOUNT_INACTIVE";
  return null;
}

/** Apply the provider policy to the observed verification signal (pure). */
export function emailTrustedForBootstrap(
  policy: ProviderPolicy,
  emailVerified: boolean | undefined
): boolean {
  return policy.emailBootstrapTrust === "require-true"
    ? emailVerified === true
    : emailVerified !== false;
}

/**
 * Decide a login (docs/identity-providers.md §4).
 *
 * Bound path: (provider, namespace, subject) matched -> only active checks;
 * email NEVER consulted. Provider match is structural (part of the lookup key).
 *
 * First-login path (unbound rows only), check order:
 *   bound-elsewhere -> provider -> namespace-captured -> namespace-match ->
 *   email-trust (per provider policy) -> active checks.
 */
export function decideLogin(input: LoginInput): LoginDecision {
  const { identity, policy, boundUser, emailUser } = input;

  if (boundUser) {
    const inactive = activeCheck(boundUser);
    if (inactive) return deny(inactive);
    return { kind: "admit", userId: boundUser.id, accountId: boundUser.accountId, bind: false };
  }

  if (!identity.email) return deny("NO_EMAIL_CLAIM");
  if (!emailUser) return deny("NOT_PROVISIONED");

  if (emailUser.subjectIdentifier !== null) return deny("EMAIL_ALREADY_BOUND");
  if (emailUser.identityProvider !== identity.provider) return deny("PROVIDER_MISMATCH");
  if (emailUser.issuerNamespace === null) return deny("NAMESPACE_NOT_CAPTURED");
  if (emailUser.issuerNamespace !== identity.issuerNamespace) return deny("NAMESPACE_MISMATCH");
  if (!emailTrustedForBootstrap(policy, identity.emailVerified)) {
    return deny("EMAIL_NOT_VERIFIED");
  }

  const inactive = activeCheck(emailUser);
  if (inactive) return deny(inactive);

  return { kind: "admit", userId: emailUser.id, accountId: emailUser.accountId, bind: true };
}

// ---- audit helpers -----------------------------------------------------------------

/** Truncated SHA-256 of a claimed email for denial telemetry (never the raw value). */
export function emailTelemetryHash(email: string | null): string | null {
  if (!email) return null;
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
}
