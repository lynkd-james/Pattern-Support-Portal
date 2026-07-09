// =============================================================================
// Provider- AND realm-independent login/callback handler factories.
//
// ONE implementation of the flow — per-flow secrets, state + realm + provider
// cookie checks, back-channel code exchange, adapter claim normalisation,
// namespace-pinned resolution via the pure decision engine, once-only subject
// binding, session issue, uniform information-free denials, audit — shared by
// every provider (Stage 8c) AND every realm (Stage 10a). Routes invoke
// makeLoginHandler(realm, provider) / makeCallbackHandler(realm, provider).
// The `realm` (AuthRealm) supplies all realm-specific behaviour; this module
// imports NEITHER customer nor admin code.
//
// Failure surfaces (unchanged):
//   * FLOW failures  -> redirect realm.loginPath?error=auth (retryable,
//     info-free; server-logged; frequency is alerting telemetry).
//   * IDENTITY denials (anything after a successfully redeemed token) -> the
//     SAME info-free 403 for every reason + an audit row.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("auth/handlers.ts is server-only.");
}

import { NextResponse, type NextRequest } from "next/server";
import { AUTH_FLOW_COOKIE_NAME } from "@/lib/authCookies";
import { createLogger } from "../logger";
import { policyFor } from "./policy";
import {
  FLOW_COOKIE_MAX_AGE_S,
  cookiesSecure,
  newFlowSecrets,
  parseFlowSecrets,
  serializeFlowSecrets,
} from "./flow";
import {
  decideLogin,
  isIdentityDeny,
  type CandidateUser,
  type IdentityProviderId,
  type LoginDenyReason,
} from "./identity";
import type { AuthRealm } from "./realm";
import { apiErrorResponse } from "../apiError";

const log = createLogger("auth");

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

function flowFailure(req: NextRequest, realm: AuthRealm, provider: IdentityProviderId, reason: string): NextResponse {
  log.warn("login_flow_failed", { realm: realm.name, provider, reason });
  return clearFlowCookie(
    NextResponse.redirect(new URL(`${realm.loginPath}?error=auth`, req.url), 302)
  );
}

/** Uniform 403 for EVERY identity denial — no reason detail reaches the client. */
function denyResponse(realm: AuthRealm): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Access denied</title></head>
<body style="font-family:system-ui,sans-serif;background:#0A0706;color:#D9CFBE;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="max-width:28rem;text-align:center;padding:2rem">
<h1 style="color:#F7F2E8;font-size:1.25rem;font-weight:500">Access denied</h1>
<p style="font-size:0.9rem;line-height:1.5">This account is not authorised for the
Pattern Support Portal. If you believe this is a mistake, contact Pattern support.</p>
<p><a href="${realm.loginPath}" style="color:#9C8E78">Back to sign-in</a></p>
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
  realm: AuthRealm,
  provider: IdentityProviderId,
  reason: LoginDenyReason,
  telemetry: { namespace: string | null; email: string | null },
  user?: CandidateUser | null
): Promise<NextResponse> {
  log.warn("login_denied", { realm: realm.name, provider, reason, namespace: telemetry.namespace });
  await realm.auditDenied({
    provider,
    namespace: telemetry.namespace,
    reason,
    claimedEmail: telemetry.email,
    userId: user?.id ?? null,
    accountId: user?.accountId ?? null,
  });
  return denyResponse(realm);
}

/** GET handler: start the sign-in flow for `realm`/`provider`. */
export function makeLoginHandler(realm: AuthRealm, provider: IdentityProviderId) {
  return async function GET() {
    try {
      const { state, nonce, codeVerifier, codeChallenge } = newFlowSecrets(realm.name, provider);
      const authorizeUrl = await realm.getAdapter(provider).buildAuthUrl({ state, nonce, codeChallenge });

      const res = NextResponse.redirect(authorizeUrl, 302);
      res.cookies.set(
        AUTH_FLOW_COOKIE_NAME,
        serializeFlowSecrets({ realm: realm.name, provider, state, nonce, codeVerifier }),
        { httpOnly: true, secure: cookiesSecure(), sameSite: "lax", path: "/", maxAge: FLOW_COOKIE_MAX_AGE_S }
      );
      return res;
    } catch (err) {
      return apiErrorResponse(err, `auth/${realm.name}/${provider}/login`);
    }
  };
}

/** GET handler: complete the sign-in flow for `realm`/`provider`. */
export function makeCallbackHandler(realm: AuthRealm, provider: IdentityProviderId) {
  return async function GET(req: NextRequest) {
    try {
      const params = req.nextUrl.searchParams;
      if (params.get("error")) {
        return flowFailure(req, realm, provider, `provider_error:${params.get("error")}`);
      }

      const code = params.get("code");
      const state = params.get("state");
      if (!code || !state) return flowFailure(req, realm, provider, "missing_code_or_state");

      const flowCookie = req.cookies.get(AUTH_FLOW_COOKIE_NAME)?.value;
      const flow = flowCookie ? parseFlowSecrets(flowCookie) : null;
      if (!flow) return flowFailure(req, realm, provider, "missing_flow_cookie");
      // Cross-realm + cross-provider replay defence: the flow cookie must match
      // BOTH this route's realm and provider.
      if (flow.realm !== realm.name) return flowFailure(req, realm, provider, "realm_mismatch_cookie");
      if (flow.provider !== provider) return flowFailure(req, realm, provider, "provider_mismatch_cookie");
      if (state !== flow.state) return flowFailure(req, realm, provider, "state_mismatch");

      const adapter = realm.getAdapter(provider);

      let rawClaims: Record<string, unknown>;
      try {
        const raw = await adapter.redeemCode({ code, codeVerifier: flow.codeVerifier });
        if (!raw) return flowFailure(req, realm, provider, "empty_token_result");
        rawClaims = raw;
      } catch (err) {
        return flowFailure(
          req,
          realm,
          provider,
          `code_exchange_failed:${err instanceof Error ? err.message : String(err)}`
        );
      }

      const validated = adapter.validateClaims(rawClaims, flow.nonce);
      if (isIdentityDeny(validated)) {
        return deniedIdentity(realm, provider, validated.reason, {
          namespace: validated.issuerNamespace,
          email: validated.email,
        });
      }
      const identity = validated;

      const boundUser = await realm.findBoundUser(identity);
      const emailUser =
        !boundUser && identity.email ? await realm.findUserByEmail(identity.email) : null;

      const decision = decideLogin({
        identity,
        policy: policyFor(identity.provider),
        boundUser,
        emailUser,
      });
      if (decision.kind === "deny") {
        return deniedIdentity(
          realm,
          provider,
          decision.reason,
          { namespace: identity.issuerNamespace, email: identity.email },
          boundUser ?? emailUser
        );
      }

      let bound = decision.bind;
      if (decision.bind) {
        const raceLost = await realm.bindSubject(decision.userId, identity.subjectIdentifier);
        if (raceLost) {
          return deniedIdentity(
            realm,
            provider,
            "EMAIL_ALREADY_BOUND",
            { namespace: identity.issuerNamespace, email: identity.email },
            emailUser
          );
        }
        bound = true;
      } else {
        await realm.stampLogin(decision.userId);
      }

      await realm.auditAdmitted({
        userId: decision.userId,
        accountId: decision.accountId,
        provider: identity.provider,
        namespace: identity.issuerNamespace,
        bound,
      });

      const { rawToken, maxAgeSeconds } = await realm.createSession(decision.userId, {
        userAgent: req.headers.get("user-agent"),
        ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      });

      log.info("login_admitted", { realm: realm.name, provider: identity.provider, userId: decision.userId, bound });

      const res = NextResponse.redirect(new URL(realm.redirectPath, req.url), 302);
      res.cookies.set(realm.cookieName, rawToken, {
        httpOnly: true,
        secure: cookiesSecure(),
        sameSite: "lax",
        path: "/",
        maxAge: maxAgeSeconds,
      });
      return clearFlowCookie(res);
    } catch (err) {
      return apiErrorResponse(err, `auth/${realm.name}/${provider}/callback`);
    }
  };
}
