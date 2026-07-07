// =============================================================================
// Entra ID-token claim normalisation (pure, Stage 8b).
//
// The ONLY place Entra claim vocabulary (tid / oid / iss / xms_edov /
// preferred_username / upn) is allowed to appear. Extracts and validates raw
// claims into the provider-neutral AuthenticatedIdentity — FACTS only; the
// email-bootstrap trust rule lives in the central policy layer (policy.ts),
// not here. No DB or network, so every branch is unit-testable.
//
// The `email` claim is ATTACKER-CONTROLLED under a multi-tenant app (any
// tenant admin can set arbitrary emails on their own users) — downstream, it
// is only ever matched WITHIN the provisioned namespace. `preferred_username`
// and `upn` are mutable/attacker-shapeable and are never read.
//
// Validation order (docs/auth.md steps 3–4, unchanged from Stage 8a):
//   nonce -> tid (namespace) -> oid (subject) -> iss/tid consistency.
// Runs AFTER the back-channel code exchange (the trust anchor).
// =============================================================================

import type { AuthenticatedIdentity, IdentityDeny } from "../identity";

const asNonEmptyString = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

/** xms_edov is documented as boolean; coerce defensively, never guess a value. */
function asOptionalBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

export function validateEntraClaims(
  raw: Record<string, unknown>,
  expectedNonce: string
): AuthenticatedIdentity | IdentityDeny {
  // Best-effort telemetry for deny paths (raw claims must not leak upstream).
  const tid = asNonEmptyString(raw.tid);
  const emailRaw = asNonEmptyString(raw.email);
  const denyTelemetry = {
    issuerNamespace: tid,
    email: emailRaw ? emailRaw.toLowerCase() : null,
  };

  const nonce = asNonEmptyString(raw.nonce);
  if (!nonce || nonce !== expectedNonce) {
    return { reason: "NONCE_MISMATCH", ...denyTelemetry };
  }

  if (!tid) return { reason: "MISSING_NAMESPACE", ...denyTelemetry };

  const oid = asNonEmptyString(raw.oid);
  if (!oid) return { reason: "MISSING_SUBJECT", ...denyTelemetry };

  const iss = asNonEmptyString(raw.iss);
  if (iss !== `https://login.microsoftonline.com/${tid}/v2.0`) {
    return { reason: "ISSUER_MISMATCH", ...denyTelemetry };
  }

  return {
    provider: "entra",
    issuerNamespace: tid,
    subjectIdentifier: oid,
    email: emailRaw ? emailRaw.toLowerCase() : null,
    emailVerified: asOptionalBool(raw.xms_edov),
    displayName: asNonEmptyString(raw.name),
  };
}
