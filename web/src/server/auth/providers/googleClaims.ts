// =============================================================================
// Google ID-token claim normalisation (pure, Stage 8c).
//
// The ONLY place Google claim vocabulary (sub / hd / email_verified / iss
// forms) is allowed to appear. Extracts and validates raw claims into the
// provider-neutral AuthenticatedIdentity — FACTS only; the email-bootstrap
// trust rule (email_verified must be true) lives in the central policy layer
// (policy.ts), not here. No DB or network, so every branch is unit-testable.
//
// Validation order (docs/identity-providers.md §4):
//   nonce -> sub present (MISSING_SUBJECT) -> hd present (MISSING_NAMESPACE —
//   absence means a consumer account, out of scope by design) -> iss in the
//   two documented forms (ISSUER_MISMATCH).
// Google's issuer is GLOBAL ("https://accounts.google.com" or
// "accounts.google.com") — unlike Entra there is no per-tenant issuer, so the
// organisational namespace lives ENTIRELY in `hd`. `sub` is documented unique
// among all Google accounts and never reused (unique within any hd a
// fortiori). Runs AFTER the back-channel code exchange + JWKS verification.
// =============================================================================

import type { AuthenticatedIdentity, IdentityDeny } from "../identity";

const VALID_ISSUERS: ReadonlySet<string> = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

const asNonEmptyString = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

/** email_verified is documented boolean; coerce defensively, never guess. */
function asOptionalBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

export function validateGoogleClaims(
  raw: Record<string, unknown>,
  expectedNonce: string
): AuthenticatedIdentity | IdentityDeny {
  // Best-effort telemetry for deny paths (raw claims must not leak upstream).
  const hd = asNonEmptyString(raw.hd);
  const emailRaw = asNonEmptyString(raw.email);
  const denyTelemetry = {
    issuerNamespace: hd,
    email: emailRaw ? emailRaw.toLowerCase() : null,
  };

  const nonce = asNonEmptyString(raw.nonce);
  if (!nonce || nonce !== expectedNonce) {
    return { reason: "NONCE_MISMATCH", ...denyTelemetry };
  }

  const sub = asNonEmptyString(raw.sub);
  if (!sub) return { reason: "MISSING_SUBJECT", ...denyTelemetry };

  // No hd => consumer Google account => no organisational namespace to pin.
  if (!hd) return { reason: "MISSING_NAMESPACE", ...denyTelemetry };

  const iss = asNonEmptyString(raw.iss);
  if (!iss || !VALID_ISSUERS.has(iss)) {
    return { reason: "ISSUER_MISMATCH", ...denyTelemetry };
  }

  return {
    provider: "google",
    issuerNamespace: hd.toLowerCase(),
    subjectIdentifier: sub,
    email: emailRaw ? emailRaw.toLowerCase() : null,
    emailVerified: asOptionalBool(raw.email_verified),
    displayName: asNonEmptyString(raw.name),
  };
}
