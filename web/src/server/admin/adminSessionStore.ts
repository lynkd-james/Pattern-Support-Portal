// =============================================================================
// DB-backed ADMIN sessions (Stage 10a) — a separate realm from customer
// sessions. Distinct table (admin_sessions) + distinct cookie
// (pattern_admin_session) => cross-realm acceptance is structurally
// impossible. Reuses the realm-agnostic pure helpers (sessionValidity,
// hashSessionToken) from auth/sessionStore; admins have no account, so the
// account-active check is always TRUE and only admin_users.is_active gates.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("admin/adminSessionStore.ts is server-only.");
}

import { randomBytes } from "node:crypto";
import { env } from "../env";
import { query } from "../db";
import { hashSessionToken, sessionValidity } from "../auth/sessionStore";

const LAST_SEEN_REFRESH_MS = 5 * 60_000;

export interface ResolvedAdminSession {
  sessionId: string;
  adminUserId: string;
  email: string;
  displayName: string | null;
  role: string;
}

interface AdminSessionRow {
  session_id: string;
  created_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  admin_user_id: string;
  email: string;
  display_name: string | null;
  role: string;
  admin_active: boolean;
}

/** Create an admin session; returns the RAW token (cookie only, never the DB). */
export async function createAdminSession(
  adminUserId: string,
  meta: { userAgent: string | null; ip: string | null }
): Promise<{ rawToken: string; maxAgeSeconds: number }> {
  const rawToken = randomBytes(32).toString("base64url");
  const maxAgeSeconds = env.sessionMaxHours * 3600;
  await query(
    `INSERT INTO admin_sessions (admin_user_id, session_token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [adminUserId, hashSessionToken(rawToken), env.sessionMaxHours, meta.userAgent, meta.ip]
  );
  return { rawToken, maxAgeSeconds };
}

/** Resolve a raw admin cookie token to an ACTIVE admin session, or null. */
export async function resolveAdminSession(rawToken: string): Promise<ResolvedAdminSession | null> {
  const res = await query<AdminSessionRow>(
    `SELECT s.id AS session_id, s.created_at, s.last_seen_at, s.revoked_at,
            u.id AS admin_user_id, u.email, u.display_name, u.role,
            u.is_active AS admin_active
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.admin_user_id
      WHERE s.session_token_hash = $1`,
    [hashSessionToken(rawToken)]
  );
  const row = res.rows[0];
  if (!row) return null;

  const now = Date.now();
  const validity = sessionValidity(
    {
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      userActive: row.admin_active,
      accountActive: true, // admins have no account; only is_active gates
    },
    now,
    env.sessionIdleHours,
    env.sessionMaxHours
  );
  if (validity !== "active") return null;

  if (now - row.last_seen_at.getTime() > LAST_SEEN_REFRESH_MS) {
    await query(`UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1`, [row.session_id]);
  }

  return {
    sessionId: row.session_id,
    adminUserId: row.admin_user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
}

/** Revoke the admin session behind a raw cookie token (logout). Idempotent. */
export async function revokeAdminSession(rawToken: string): Promise<void> {
  await query(
    `UPDATE admin_sessions SET revoked_at = now()
      WHERE session_token_hash = $1 AND revoked_at IS NULL`,
    [hashSessionToken(rawToken)]
  );
}
