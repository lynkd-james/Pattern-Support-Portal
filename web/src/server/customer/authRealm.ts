// =============================================================================
// Customer auth realm (Stage 10a extraction — behaviour byte-for-byte the
// pre-realm customer flow). Supplies the customer-specific data access,
// cookie, and redirect targets to the shared handler factory. Lives in the
// customer tree; the admin tree never imports it.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("customer/authRealm.ts is server-only.");
}

import { SESSION_COOKIE_NAME } from "@/lib/authCookies";
import { query, withTransaction } from "../db";
import { getAdapter } from "../auth/provider";
import {
  type AuthenticatedIdentity,
  type CandidateUser,
  type IdentityProviderId,
} from "../auth/identity";
import type { AuthRealm } from "../auth/realm";
import { auditLoginAdmitted, auditLoginDenied } from "../auth/audit";
import { createSession } from "../auth/sessionStore";

const CANDIDATE_SELECT = `
  SELECT u.id, u.account_id, u.identity_provider, u.issuer_namespace,
         u.subject_identifier, u.is_active AS user_active,
         a.is_active AS account_active
    FROM portal_users u
    JOIN accounts a ON a.id = u.account_id`;

interface CandidateRow {
  id: string;
  account_id: string;
  identity_provider: IdentityProviderId;
  issuer_namespace: string | null;
  subject_identifier: string | null;
  user_active: boolean;
  account_active: boolean;
}

const toCandidate = (r: CandidateRow | undefined): CandidateUser | null =>
  r
    ? {
        id: r.id,
        accountId: r.account_id,
        identityProvider: r.identity_provider,
        issuerNamespace: r.issuer_namespace,
        subjectIdentifier: r.subject_identifier,
        userActive: r.user_active,
        accountActive: r.account_active,
      }
    : null;

export const customerRealm: AuthRealm = {
  name: "customer",
  cookieName: SESSION_COOKIE_NAME,
  redirectPath: "/dashboard",
  loginPath: "/login",

  getAdapter(provider: IdentityProviderId) {
    return getAdapter(provider);
  },

  async findBoundUser(identity: AuthenticatedIdentity) {
    const res = await query<CandidateRow>(
      `${CANDIDATE_SELECT}
        WHERE u.identity_provider = $1 AND u.issuer_namespace = $2
          AND u.subject_identifier = $3`,
      [identity.provider, identity.issuerNamespace, identity.subjectIdentifier]
    );
    return toCandidate(res.rows[0]);
  },

  async findUserByEmail(email: string) {
    const res = await query<CandidateRow>(`${CANDIDATE_SELECT} WHERE u.email = $1`, [email]);
    return toCandidate(res.rows[0]);
  },

  async bindSubject(userId: string, subject: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE portal_users
            SET subject_identifier = $2, last_login_at = now(), updated_at = now()
          WHERE id = $1 AND subject_identifier IS NULL`,
        [userId, subject]
      );
      if (upd.rowCount === 1) return false;
      const cur = await client.query<{ subject_identifier: string | null }>(
        `SELECT subject_identifier FROM portal_users WHERE id = $1`,
        [userId]
      );
      return cur.rows[0]?.subject_identifier !== subject; // true = conflicting concurrent bind
    });
  },

  async stampLogin(userId: string) {
    await query(
      `UPDATE portal_users SET last_login_at = now(), updated_at = now() WHERE id = $1`,
      [userId]
    );
  },

  createSession(userId, meta) {
    return createSession(userId, meta);
  },

  auditAdmitted(args) {
    return auditLoginAdmitted(args);
  },
  auditDenied(args) {
    return auditLoginDenied(args);
  },
};
