// =============================================================================
// GET /api/auth/callback — complete the Entra sign-in flow.
//
// Stage 8b: the handler is provider-agnostic — it drives an
// IdentityProviderAdapter (Entra wired on this route; Google gets a parallel
// route in Stage 8c) and operates exclusively on AuthenticatedIdentity /
// IdentityDeny. Provider claim vocabulary never appears here.
//
// Validation order (docs/auth.md, unchanged): state (CSRF, pre-exchange) ->
// code exchange (back-channel TLS with the token endpoint is the ID token's
// trust anchor — not local signature validation) -> adapter claim validation
// (nonce -> namespace -> subject -> issuer consistency) -> user resolution
// with NAMESPACE PINNING -> active checks -> first-login subject binding ->
// session.
//
// Failure surfaces are deliberately split (Stage 8a semantics preserved):
//   * FLOW failures (missing/expired flow cookie, state mismatch, provider
//     mismatch on the cookie, provider error param, failed code exchange)
//     -> redirect to /login?error=auth (retryable, information-free; detail
//     logged server-side; frequency is alerting telemetry).
//   * IDENTITY denials (anything after a successfully redeemed token) -> the
//     SAME information-free 403 page for every reason, plus an audit_events
//     row with provider + namespace + reason + hashed claimed email.
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { AUTH_FLOW_COOKIE_NAME, SESSION_COOKIE_NAME } from "@/lib/authCookies";
import { query, withTransaction } from "@/server/db";
import { createLogger } from "@/server/logger";
import { getAdapter } from "@/server/auth/provider";
import { policyFor } from "@/server/auth/policy";
import { cookiesSecure, parseFlowSecrets } from "@/server/auth/flow";
import {
  decideLogin,
  isIdentityDeny,
  type AuthenticatedIdentity,
  type CandidateUser,
  type IdentityProviderId,
  type LoginDenyReason,
} from "@/server/auth/identity";
import { auditLoginAdmitted, auditLoginDenied } from "@/server/auth/audit";
import { createSession } from "@/server/auth/sessionStore";
import { apiErrorResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The provider this route serves. Stage 8c adds a parallel Google route. */
const ROUTE_PROVIDER: IdentityProviderId = "entra";

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
  log.warn("login_flow_failed", { provider: ROUTE_PROVIDER, reason });
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
  telemetry: { namespace: string | null; email: string | null },
  user?: CandidateUser | null
): Promise<NextResponse> {
  log.warn("login_denied", {
    provider: ROUTE_PROVIDER,
    reason,
    namespace: telemetry.namespace,
  });
  await auditLoginDenied({
    provider: ROUTE_PROVIDER,
    namespace: telemetry.namespace,
    reason,
    claimedEmail: telemetry.email,
    userId: user?.id ?? null,
    accountId: user?.accountId ?? null,
  });
  return denyResponse();
}

// ---- user lookups (provider-neutral identity columns) ------------------------

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

async function findBoundUser(identity: AuthenticatedIdentity): Promise<CandidateUser | null> {
  const res = await query<CandidateRow>(
    `${CANDIDATE_SELECT}
      WHERE u.identity_provider = $1 AND u.issuer_namespace = $2
        AND u.subject_identifier = $3`,
    [identity.provider, identity.issuerNamespace, identity.subjectIdentifier]
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

    // Provider-side error (user cancelled, consent denied, ...) — retryable.
    if (params.get("error")) {
      return flowFailure(req, `provider_error:${params.get("error")}`);
    }

    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return flowFailure(req, "missing_code_or_state");

    // Single-use flow secrets from our own cookie; cleared on every exit path.
    const flowCookie = req.cookies.get(AUTH_FLOW_COOKIE_NAME)?.value;
    const flow = flowCookie ? parseFlowSecrets(flowCookie) : null;
    if (!flow) return flowFailure(req, "missing_flow_cookie");
    // Cross-flow replay defence: the cookie must belong to THIS route's provider.
    if (flow.provider !== ROUTE_PROVIDER) return flowFailure(req, "provider_mismatch_cookie");
    if (state !== flow.state) return flowFailure(req, "state_mismatch");

    const adapter = getAdapter(ROUTE_PROVIDER);

    // Back-channel code exchange — the ID token's trust anchor.
    let rawClaims: Record<string, unknown>;
    try {
      const raw = await adapter.redeemCode({ code, codeVerifier: flow.codeVerifier });
      if (!raw) return flowFailure(req, "empty_token_result");
      rawClaims = raw;
    } catch (err) {
      return flowFailure(
        req,
        `code_exchange_failed:${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Adapter claim normalisation (pure). From here on, every failure is an
    // IDENTITY denial: uniform 403 + audit (telemetry from the typed deny —
    // raw claims never leave the adapter).
    const validated = adapter.validateClaims(rawClaims, flow.nonce);
    if (isIdentityDeny(validated)) {
      return deniedIdentity(validated.reason, {
        namespace: validated.issuerNamespace,
        email: validated.email,
      });
    }
    const identity = validated;

    // Resolution: bound (provider, namespace, subject) first; email only for
    // unbound identities (decideLogin enforces provider + namespace pinning
    // and the centralised provider policy).
    const boundUser = await findBoundUser(identity);
    const emailUser =
      !boundUser && identity.email ? await findUserByEmail(identity.email) : null;

    const decision = decideLogin({
      identity,
      policy: policyFor(identity.provider),
      boundUser,
      emailUser,
    });
    if (decision.kind === "deny") {
      return deniedIdentity(
        decision.reason,
        { namespace: identity.issuerNamespace, email: identity.email },
        boundUser ?? emailUser
      );
    }

    // Admit: bind the subject on first login (guarded against a concurrent
    // bind), then stamp last_login_at.
    let bound = decision.bind;
    if (decision.bind) {
      const raceLost = await withTransaction(async (client) => {
        const upd = await client.query(
          `UPDATE portal_users
              SET subject_identifier = $2, last_login_at = now(), updated_at = now()
            WHERE id = $1 AND subject_identifier IS NULL`,
          [decision.userId, identity.subjectIdentifier]
        );
        if (upd.rowCount === 1) return false;
        // A concurrent login bound this row first. Identical subject => benign
        // (same person, double-submit); anything else => deny.
        const cur = await client.query<{ subject_identifier: string | null }>(
          `SELECT subject_identifier FROM portal_users WHERE id = $1`,
          [decision.userId]
        );
        return cur.rows[0]?.subject_identifier !== identity.subjectIdentifier;
      });
      if (raceLost) {
        return deniedIdentity(
          "EMAIL_ALREADY_BOUND",
          { namespace: identity.issuerNamespace, email: identity.email },
          emailUser
        );
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
      provider: identity.provider,
      namespace: identity.issuerNamespace,
      bound,
    });

    const { rawToken, maxAgeSeconds } = await createSession(decision.userId, {
      userAgent: req.headers.get("user-agent"),
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });

    log.info("login_admitted", {
      provider: identity.provider,
      userId: decision.userId,
      bound,
    });

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
