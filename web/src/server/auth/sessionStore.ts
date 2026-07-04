// =============================================================================
// DB-backed portal sessions (server-only, Stage 8a).
//
// Raw session tokens are random 256-bit values handed to the browser in an
// httpOnly cookie; ONLY their SHA-256 lands in portal_sessions. Validity is
// enforced HERE, at resolution, on every request (Amendment 3) — the cookie's
// Max-Age is UX only:
//   * revoked_at IS NULL
//   * now < created_at + SESSION_MAX_HOURS   (absolute cap; expires_at mirrors it)
//   * now < last_seen_at + SESSION_IDLE_HOURS (sliding idle)
//   * portal_users.is_active AND accounts.is_active (deactivation kills live
//     sessions immediately)
// The validity decision is a pure function so every branch is unit-testable.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("auth/sessionStore.ts is server-only.");
}

import { createHash, randomBytes } from "node:crypto";
import { env } from "../env";
import { query } from "../db";

const HOUR_MS = 3_600_000;
/** last_seen_at refresh is throttled to avoid a write per request. */
const LAST_SEEN_REFRESH_MS = 5 * 60_000;

export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// ---- pure validity decision --------------------------------------------------

export type SessionValidity =
  | "active"
  | "revoked"
  | "expired_absolute"
  | "expired_idle"
  | "user_inactive"
  | "account_inactive";

export interface SessionCheckInput {
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  userActive: boolean;
  accountActive: boolean;
}

export function sessionValidity(
  s: SessionCheckInput,
  nowMs: number,
  idleHours: number,
  maxHours: number
): SessionValidity {
  if (s.revokedAt !== null) return "revoked";
  if (nowMs >= s.createdAt.getTime() + maxHours * HOUR_MS) return "expired_absolute";
  if (nowMs >= s.lastSeenAt.getTime() + idleHours * HOUR_MS) return "expired_idle";
  if (!s.userActive) return "user_inactive";
  if (!s.accountActive) return "account_inactive";
  return "active";
}

// ---- store operations ----------------------------------------------------------

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string | null;
  accountWide: boolean;
  accountId: string;
  accountName: string;
}

interface SessionRow {
  session_id: string;
  created_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  user_id: string;
  email: string;
  display_name: string | null;
  account_wide: boolean;
  user_active: boolean;
  account_id: string;
  account_name: string;
  account_active: boolean;
}

/** Create a session; returns the RAW token (goes into the cookie, never the DB). */
export async function createSession(
  userId: string,
  meta: { userAgent: string | null; ip: string | null }
): Promise<{ rawToken: string; maxAgeSeconds: number }> {
  const rawToken = randomBytes(32).toString("base64url");
  const maxAgeSeconds = env.sessionMaxHours * 3600;
  await query(
    `INSERT INTO portal_sessions (user_id, session_token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [userId, hashSessionToken(rawToken), env.sessionMaxHours, meta.userAgent, meta.ip]
  );
  return { rawToken, maxAgeSeconds };
}

/**
 * Resolve a raw cookie token to an ACTIVE session, or null. Applies the full
 * validity decision above and refreshes last_seen_at (throttled).
 */
export async function resolveSession(rawToken: string): Promise<ResolvedSession | null> {
  const res = await query<SessionRow>(
    `SELECT s.id AS session_id, s.created_at, s.last_seen_at, s.revoked_at,
            u.id AS user_id, u.email, u.display_name, u.account_wide,
            u.is_active AS user_active,
            a.id AS account_id, a.name AS account_name, a.is_active AS account_active
       FROM portal_sessions s
       JOIN portal_users u ON u.id = s.user_id
       JOIN accounts a ON a.id = u.account_id
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
      userActive: row.user_active,
      accountActive: row.account_active,
    },
    now,
    env.sessionIdleHours,
    env.sessionMaxHours
  );
  if (validity !== "active") return null;

  if (now - row.last_seen_at.getTime() > LAST_SEEN_REFRESH_MS) {
    await query(`UPDATE portal_sessions SET last_seen_at = now() WHERE id = $1`, [
      row.session_id,
    ]);
  }

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    accountWide: row.account_wide,
    accountId: row.account_id,
    accountName: row.account_name,
  };
}

/** Revoke the session behind a raw cookie token (logout). Idempotent. */
export async function revokeSession(rawToken: string): Promise<void> {
  await query(
    `UPDATE portal_sessions SET revoked_at = now()
      WHERE session_token_hash = $1 AND revoked_at IS NULL`,
    [hashSessionToken(rawToken)]
  );
}
