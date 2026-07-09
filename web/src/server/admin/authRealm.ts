// =============================================================================
// Admin auth realm (Stage 10a). Supplies admin-specific data access, cookie,
// redirect targets, and the SEPARATE single-tenant admin Entra adapter to the
// shared handler factory. Fully isolated: this file lives in the admin tree
// and is never imported by customer code (and imports no customer code).
//
// decideLogin is reused unchanged — an admin is an identity that must be
// provisioned + namespace-pinned + active. Admins have no account scope, so
// CandidateUser.accountId is set to the admin user id (unused downstream) and
// accountActive is TRUE (only admin_users.is_active gates; enforced again at
// session-resolution time).
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("admin/authRealm.ts is server-only.");
}

import { ADMIN_SESSION_COOKIE_NAME } from "@/lib/authCookies";
import { query, withTransaction } from "../db";
import { requireAdminAuth } from "../env";
import { makeEntraClient } from "../auth/providers/msal";
import { makeEntraAdapter } from "../auth/providers/entra";
import type { IdentityProviderAdapter } from "../auth/provider";
import {
  type AuthenticatedIdentity,
  type CandidateUser,
  type IdentityProviderId,
} from "../auth/identity";
import type { AuthRealm } from "../auth/realm";
import { createAdminSession } from "./adminSessionStore";
import { auditAdminLoginAdmitted, auditAdminLoginDenied } from "./adminAudit";

const ADMIN_REDIRECT_PATH = "/api/admin/auth/callback";

// Separate single-tenant admin Entra app (Option A). Own client id/secret,
// Pattern-tenant authority, own redirect path.
const adminEntraClient = makeEntraClient(() => {
  const cfg = requireAdminAuth();
  return {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    authority: cfg.authority,
    redirectUri: `${cfg.baseUrl}${ADMIN_REDIRECT_PATH}`,
  };
});
const adminEntraAdapter = makeEntraAdapter(adminEntraClient);

const CANDIDATE_SELECT = `
  SELECT id, identity_provider, issuer_namespace, subject_identifier,
         is_active AS user_active
    FROM admin_users`;

interface AdminCandidateRow {
  id: string;
  identity_provider: IdentityProviderId;
  issuer_namespace: string | null;
  subject_identifier: string | null;
  user_active: boolean;
}

const toCandidate = (r: AdminCandidateRow | undefined): CandidateUser | null =>
  r
    ? {
        id: r.id,
        accountId: r.id, // admins have no account; unused downstream
        identityProvider: r.identity_provider,
        issuerNamespace: r.issuer_namespace,
        subjectIdentifier: r.subject_identifier,
        userActive: r.user_active,
        accountActive: true, // no account gate for admins
      }
    : null;

export const adminRealm: AuthRealm = {
  name: "admin",
  cookieName: ADMIN_SESSION_COOKIE_NAME,
  redirectPath: "/admin",
  loginPath: "/admin/login",

  getAdapter(provider: IdentityProviderId): IdentityProviderAdapter {
    if (provider !== "entra") {
      throw new Error(`Admin realm supports only Entra; got "${provider}".`);
    }
    return adminEntraAdapter;
  },

  async findBoundUser(identity: AuthenticatedIdentity) {
    const res = await query<AdminCandidateRow>(
      `${CANDIDATE_SELECT}
        WHERE identity_provider = $1 AND issuer_namespace = $2 AND subject_identifier = $3`,
      [identity.provider, identity.issuerNamespace, identity.subjectIdentifier]
    );
    return toCandidate(res.rows[0]);
  },

  async findUserByEmail(email: string) {
    const res = await query<AdminCandidateRow>(`${CANDIDATE_SELECT} WHERE email = $1`, [email]);
    return toCandidate(res.rows[0]);
  },

  async bindSubject(userId: string, subject: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE admin_users
            SET subject_identifier = $2, last_login_at = now(), updated_at = now()
          WHERE id = $1 AND subject_identifier IS NULL`,
        [userId, subject]
      );
      if (upd.rowCount === 1) return false;
      const cur = await client.query<{ subject_identifier: string | null }>(
        `SELECT subject_identifier FROM admin_users WHERE id = $1`,
        [userId]
      );
      return cur.rows[0]?.subject_identifier !== subject;
    });
  },

  async stampLogin(userId: string) {
    await query(`UPDATE admin_users SET last_login_at = now(), updated_at = now() WHERE id = $1`, [userId]);
  },

  createSession(userId, meta) {
    return createAdminSession(userId, meta);
  },

  auditAdmitted(args) {
    return auditAdminLoginAdmitted({
      userId: args.userId,
      provider: args.provider,
      namespace: args.namespace,
      bound: args.bound,
    });
  },
  auditDenied(args) {
    return auditAdminLoginDenied({
      provider: args.provider,
      namespace: args.namespace,
      reason: args.reason,
      claimedEmail: args.claimedEmail,
      userId: args.userId,
    });
  },
};
