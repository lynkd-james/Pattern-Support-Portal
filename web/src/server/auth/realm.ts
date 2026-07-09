// =============================================================================
// AuthRealm — the seam that lets ONE login/callback orchestration serve both
// the customer and admin realms (Stage 10a) without duplicating the
// security-critical flow, and without auth/handlers.ts importing either realm.
//
// The realm supplies everything realm-SPECIFIC: which OIDC adapter/app to use,
// how to look up + bind + session a user, its cookie name and redirect paths,
// and how to audit. The shared mechanics (flow secrets, adapter claim
// normalisation, the pure decideLogin engine, provider policy) live in
// auth/* and are reused unchanged. Realm implementations live in their own
// isolated trees (server/customer/**, server/admin/**) and are passed IN to
// the handler factory by their routes — handlers.ts imports neither.
// =============================================================================

import type { IdentityProviderAdapter } from "./provider";
import type {
  AuthenticatedIdentity,
  CandidateUser,
  IdentityProviderId,
  LoginDenyReason,
} from "./identity";
import type { AuthRealmName } from "./flow";

export interface AuthRealm {
  readonly name: AuthRealmName;
  /** Providers this realm's routes accept (customer: entra+google; admin: entra). */
  readonly cookieName: string;
  /** Where to send a completed login (fixed; no return-URL surface). */
  readonly redirectPath: string;
  /** Where flow failures / the deny page point back to. */
  readonly loginPath: string;

  /** Resolve the OIDC adapter for a provider in THIS realm (app registration). */
  getAdapter(provider: IdentityProviderId): IdentityProviderAdapter;

  findBoundUser(identity: AuthenticatedIdentity): Promise<CandidateUser | null>;
  findUserByEmail(email: string): Promise<CandidateUser | null>;

  /**
   * Bind the subject on first login, guarded against a concurrent bind.
   * Returns true iff the bind was LOST to a conflicting concurrent bind
   * (different subject) — the caller then denies EMAIL_ALREADY_BOUND. An
   * identical-subject concurrent bind (benign double-submit) returns false.
   */
  bindSubject(userId: string, subject: string): Promise<boolean>;
  /** Stamp last_login_at on the bound-path (no binding performed). */
  stampLogin(userId: string): Promise<void>;

  createSession(
    userId: string,
    meta: { userAgent: string | null; ip: string | null }
  ): Promise<{ rawToken: string; maxAgeSeconds: number }>;

  auditAdmitted(args: {
    userId: string;
    accountId: string;
    provider: IdentityProviderId;
    namespace: string;
    bound: boolean;
  }): Promise<void>;
  auditDenied(args: {
    provider: IdentityProviderId;
    namespace: string | null;
    reason: LoginDenyReason;
    claimedEmail: string | null;
    userId?: string | null;
    accountId?: string | null;
  }): Promise<void>;
}
