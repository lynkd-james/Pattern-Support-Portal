// =============================================================================
// GET /api/auth/callback — complete the Entra sign-in flow (Stage 8a).
//
// Validation order (docs/auth.md): state (CSRF, pre-exchange) -> code exchange
// (the ID token's trust anchor is the authenticated back-channel TLS exchange
// with the token endpoint — not local signature validation) -> nonce ->
// tid/oid presence -> iss/tid consistency -> user resolution with TENANT
// PINNING -> active checks -> first-login oid binding -> session.
//
// Failure surfaces are deliberately split:
//   * FLOW failures (missing/expired flow cookie, state mismatch, Entra error
//     param, failed code exchange) -> redirect to /login?error=auth (retryable,
//     information-free; detail logged server-side).
//   * IDENTITY denials (anything after a successfully validated token) -> the
//     SAME information-free 403 page for every reason, plus an audit_events row
//     with tid + reason + hashed claimed email (attack telemetry, Amendment 1).
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { AUTH_FLOW_COOKIE_NAME, SESSION_COOKIE_NAME } from "@/lib/authCookies";
import { query, withTransaction } from "@/server/db";
import { createLogger } from "@/server/logger";
import { redeemAuthCode } from "@/server/auth/msal";
import { cookiesSecure, parseFlowSecrets } from "@/server/auth/flow";
import {
  decideLogin,
  validateIdTokenClaims,
  type CandidateUser,
  type LoginDenyReason,
  type ValidatedClaims,
} from "@/server/auth/identity";
import { auditLoginAdmitted, auditLoginDenied } from "@/server/auth/audit";
import { createSession } from "@/server/auth/sessionStore";
import { apiErrorResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("auth");

// ---- responses (all information-free towards the client) --------------------

function clearFlowCookie(res: NextResponse): NextResponse {
  res.cookies.set(AUTH_FLOW_COOKIE_NAME, "", {
    httpOnly: true,
    secure: cookiesSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}

/** Retryable flow failure: back to /login with a generic marker. */
function flowFailure(req: NextRequest, reason: string): NextResponse {
  log.warn("login_flow_failed", { reason });
  return clearFlowCookie(
    NextResponse.redirect(new URL("/login?error=auth", req.url), 302)
  );
}

/** Uniform 403 for EVERY identity denial — no reason detail reaches the client. */
function denyResponse(): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Access denied</title></head>
<body style="font-family:system-ui,sans-serif;background:#0A0706;color:#D9CFBE;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="max-width:28rem;text-align:center;padding:2rem">
<h1 style="color:#F7F2E8;font-size:1.25rem;font-weight:500">Access denied</h1>
<p style="font-size:0.9rem;line-height:1.5">This account is not authorised for the
Pattern Support Portal. If you believe this is a mistake, contact Pattern support.</p>
<p><a href="/login" style="color:#9C8E78">Back to sign-in</a></p>
</div>
</body>
</html>`;
  return clearFlowCookie(
    new NextResponse(html, {
      status: 403,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  );
}

async function deniedIdentity(
  reason: LoginDenyReason,
  claims: Partial<ValidatedClaims>,
  user?: CandidateUser | null
): Promise<NextResponse> {
  log.warn("login_denied", { reason, tid: claims.tid ?? null });
  await auditLoginDenied({
    tid: claims.tid ?? null,
    reason,
    claimedEmail: claims.email ?? null,
    userId: user?.id ?? null,
    accountId: user?.accountId ?? null,
  });
  return denyResponse();
}

// ---- user lookups ------------------------------------------------------------

const CANDIDATE_SELECT = `
  SELECT u.id, u.account_id, u.entra_tenant_id, u.entra_object_id,
         u.is_active AS user_active, a.is_active AS account_active
    FROM portal_users u
    JOIN accounts a ON a.id = u.account_id`;

interface CandidateRow {
  id: string;
  account_id: string;
  entra_tenant_id: string | null;
  entra_object_id: string | null;
  user_active: boolean;
  account_active: boolean;
}

const toCandidate = (r: CandidateRow | undefined): CandidateUser | null =>
  r
    ? {
        id: r.id,
        accountId: r.account_id,
        entraTenantId: r.entra_tenant_id,
        entraObjectId: r.entra_object_id,
        userActive: r.user_active,
        accountActive: r.account_active,
      }
    : null;

async function findBoundUser(tid: string, oid: string): Promise<CandidateUser | null> {
  const res = await query<CandidateRow>(
    `${CANDIDATE_SELECT} WHERE u.entra_tenant_id = $1 AND u.entra_object_id = $2`,
    [tid, oid]
  );
  return toCandidate(res.rows[0]);
}

async function findUserByEmail(email: string): Promise<CandidateUser | null> {
  const res = await query<CandidateRow>(`${CANDIDATE_SELECT} WHERE u.email = $1`, [
    email,
  ]);
  return toCandidate(res.rows[0]);
}

// ---- handler -------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;

    // Entra-side error (user cancelled, consent denied, ...) — retryable.
    if (params.get("error")) {
      return flowFailure(req, `entra_error:${params.get("error")}`);
    }

    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return flowFailure(req, "missing_code_or_state");

    // Single-use flow secrets from our own cookie; cleared on every exit path.
    const flowCookie = req.cookies.get(AUTH_FLOW_COOKIE_NAME)?.value;
    const flow = flowCookie ? parseFlowSecrets(flowCookie) : null;
    if (!flow) return flowFailure(req, "missing_flow_cookie");
    if (state !== flow.state) return flowFailure(req, "state_mismatch");

    // Code exchange. Trust anchor: the token comes directly from the token
    // endpoint over authenticated TLS (back-channel); claim checks are ours.
    let idTokenClaims: Record<string, unknown>;
    try {
      const result = await redeemAuthCode({ code, codeVerifier: flow.codeVerifier });
      if (!result?.idTokenClaims) return flowFailure(req, "empty_token_result");
      idTokenClaims = result.idTokenClaims as Record<string, unknown>;
    } catch (err) {
      return flowFailure(
        req,
        `code_exchange_failed:${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Claim validation (nonce -> tid -> oid -> iss consistency). From here on,
    // every failure is an IDENTITY denial: uniform 403 + audit.
    const validated = validateIdTokenClaims(idTokenClaims, flow.nonce);
    if (validated.kind === "invalid") {
      const tid = typeof idTokenClaims.tid === "string" ? idTokenClaims.tid : null;
      return deniedIdentity(validated.reason, { tid: tid ?? undefined });
    }
    const claims = validated.claims;

    // Resolution: bound (tid, oid) first; email only for unbound identities,
    // and only within the provisioned tenant (decideLogin enforces pinning).
    const boundUser = await findBoundUser(claims.tid, claims.oid);
    const emailUser =
      !boundUser && claims.email ? await findUserByEmail(claims.email) : null;

    const decision = decideLogin({ claims, boundUser, emailUser });
    if (decision.kind === "deny") {
      return deniedIdentity(decision.reason, claims, boundUser ?? emailUser);
    }

    // Admit: bind oid on first login (guarded against a concurrent bind), then
    // stamp last_login_at.
    let bound = decision.bind;
    if (decision.bind) {
      const raceLost = await withTransaction(async (client) => {
        const upd = await client.query(
          `UPDATE portal_users
              SET entra_object_id = $2, last_login_at = now(), updated_at = now()
            WHERE id = $1 AND entra_object_id IS NULL`,
          [decision.userId, claims.oid]
        );
        if (upd.rowCount === 1) return false;
        // A concurrent login bound this row first. Identical oid => benign
        // (same person, double-submit); anything else => deny.
        const cur = await client.query<{ entra_object_id: string | null }>(
          `SELECT entra_object_id FROM portal_users WHERE id = $1`,
          [decision.userId]
        );
        return cur.rows[0]?.entra_object_id !== claims.oid;
      });
      if (raceLost) {
        return deniedIdentity("EMAIL_ALREADY_BOUND", claims, emailUser);
      }
      bound = true;
    } else {
      await query(
        `UPDATE portal_users SET last_login_at = now(), updated_at = now() WHERE id = $1`,
        [decision.userId]
      );
    }

    await auditLoginAdmitted({
      userId: decision.userId,
      accountId: decision.accountId,
      tid: claims.tid,
      bound,
    });

    const { rawToken, maxAgeSeconds } = await createSession(decision.userId, {
      userAgent: req.headers.get("user-agent"),
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });

    log.info("login_admitted", { userId: decision.userId, bound });

    // Fixed post-login target (no return-URL parameter exists).
    const res = NextResponse.redirect(new URL("/dashboard", req.url), 302);
    res.cookies.set(SESSION_COOKIE_NAME, rawToken, {
      httpOnly: true,
      secure: cookiesSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: maxAgeSeconds,
    });
    return clearFlowCookie(res);
  } catch (err) {
    return apiErrorResponse(err, "auth/callback");
  }
}
