// =============================================================================
// Pure identity validation + login decision (Stage 8a). No DB or network here,
// mirroring sync/resolve.ts, so every branch is unit-testable.
//
// Trust model (see docs/auth.md): Entra authenticates; the portal DB authorises.
// The `email` claim is ATTACKER-CONTROLLED under a multi-tenant app (any tenant
// admin can set arbitrary emails on their own users), so email is only ever
// matched WITHIN the tenant pinned at provisioning time (`tid` must equal the
// user's provisioned entra_tenant_id), and never consulted again after the
// (tid, oid) binding exists. `preferred_username` is never used.
// =============================================================================

import { createHash } from "node:crypto";

// ---- claim validation --------------------------------------------------------

export interface ValidatedClaims {
  tid: string;
  oid: string;
  /** Verified-format email claim (may still be absent). Lowercased. */
  email: string | null;
  displayName: string | null;
  /** xms_edov optional claim; undefined when the tenant/app config omits it. */
  emailDomainOwnerVerified: boolean | undefined;
}

export type ClaimDenyReason =
  | "NONCE_MISMATCH"
  | "MISSING_TID"
  | "MISSING_OID"
  | "ISSUER_MISMATCH";

export type ClaimsResult =
  | { kind: "ok"; claims: ValidatedClaims }
  | { kind: "invalid"; reason: ClaimDenyReason };

const asNonEmptyString = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

/** xms_edov is documented as boolean; coerce defensively, never guess a value. */
function asOptionalBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/**
 * Validate ID-token claims after the code exchange. The token's trust anchor
 * is the authenticated back-channel TLS exchange with the token endpoint (it
 * never transits the browser); these checks are the claim-level layer on top.
 * Order (docs/auth.md steps 3–4): nonce -> tid -> oid -> iss/tid consistency.
 * Tokens missing tid or oid are rejected outright (Amendment 1).
 */
export function validateIdTokenClaims(
  raw: Record<string, unknown>,
  expectedNonce: string
): ClaimsResult {
  const nonce = asNonEmptyString(raw.nonce);
  if (!nonce || nonce !== expectedNonce) {
    return { kind: "invalid", reason: "NONCE_MISMATCH" };
  }

  const tid = asNonEmptyString(raw.tid);
  if (!tid) return { kind: "invalid", reason: "MISSING_TID" };

  const oid = asNonEmptyString(raw.oid);
  if (!oid) return { kind: "invalid", reason: "MISSING_OID" };

  const iss = asNonEmptyString(raw.iss);
  if (iss !== `https://login.microsoftonline.com/${tid}/v2.0`) {
    return { kind: "invalid", reason: "ISSUER_MISMATCH" };
  }

  const email = asNonEmptyString(raw.email);
  return {
    kind: "ok",
    claims: {
      tid,
      oid,
      email: email ? email.toLowerCase() : null,
      displayName: asNonEmptyString(raw.name),
      emailDomainOwnerVerified: asOptionalBool(raw.xms_edov),
    },
  };
}

// ---- login decision -----------------------------------------------------------

/** portal_users row shape the decision needs (joined with its account). */
export interface CandidateUser {
  id: string;
  accountId: string;
  entraTenantId: string | null;
  entraObjectId: string | null;
  userActive: boolean;
  accountActive: boolean;
}

export type LoginDenyReason =
  | ClaimDenyReason
  | "NO_EMAIL_CLAIM" // unbound identity and the token carries no email claim
  | "NOT_PROVISIONED" // no portal user matches (bound or by email)
  | "TENANT_NOT_CAPTURED" // email matched, but the row has no provisioned tenant yet
  | "TENANT_MISMATCH" // email matched, but token tid != provisioned tenant
  | "EMAIL_ALREADY_BOUND" // email matched a row already bound to a DIFFERENT oid
  | "EMAIL_NOT_VERIFIED" // xms_edov present and false
  | "USER_INACTIVE"
  | "ACCOUNT_INACTIVE";

export type LoginDecision =
  | { kind: "admit"; userId: string; accountId: string; bind: boolean }
  | { kind: "deny"; reason: LoginDenyReason };

export interface LoginInput {
  claims: ValidatedClaims;
  /** Row matched by (entra_tenant_id = tid AND entra_object_id = oid), any active state. */
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

/**
 * Decide a login (docs/auth.md steps 5–7).
 *
 * Bound path: (tid, oid) matched -> only active checks; email NEVER consulted.
 * First-login path: email match is honoured ONLY when the token's tid equals
 * the tenant provisioned on that row, and the row is not bound to another oid.
 * xms_edov === false denies; absent proceeds (tenant pinning is the primary
 * control — a foreign tenant can never reach the email comparison).
 */
export function decideLogin(input: LoginInput): LoginDecision {
  const { claims, boundUser, emailUser } = input;

  if (boundUser) {
    const inactive = activeCheck(boundUser);
    if (inactive) return deny(inactive);
    return { kind: "admit", userId: boundUser.id, accountId: boundUser.accountId, bind: false };
  }

  if (!claims.email) return deny("NO_EMAIL_CLAIM");
  if (!emailUser) return deny("NOT_PROVISIONED");

  if (emailUser.entraObjectId !== null) return deny("EMAIL_ALREADY_BOUND");
  if (emailUser.entraTenantId === null) return deny("TENANT_NOT_CAPTURED");
  if (emailUser.entraTenantId !== claims.tid) return deny("TENANT_MISMATCH");
  if (claims.emailDomainOwnerVerified === false) return deny("EMAIL_NOT_VERIFIED");

  const inactive = activeCheck(emailUser);
  if (inactive) return deny(inactive);

  return { kind: "admit", userId: emailUser.id, accountId: emailUser.accountId, bind: true };
}

// ---- audit helpers -------------------------------------------------------------

/** Truncated SHA-256 of a claimed email for denial telemetry (never the raw value). */
export function emailTelemetryHash(email: string | null): string | null {
  if (!email) return null;
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
}
