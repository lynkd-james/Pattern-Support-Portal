// =============================================================================
// GET /api/auth/login — start the Entra sign-in flow (Stage 8a).
//
// Generates per-flow secrets (CSRF state, ID-token nonce, PKCE verifier),
// stores them in a short-lived httpOnly cookie, and redirects to the Entra
// authorize endpoint. The post-login target is FIXED to /dashboard — no
// return-URL parameter exists anywhere in the flow (no open-redirect surface).
// =============================================================================

import { NextResponse } from "next/server";
import { AUTH_FLOW_COOKIE_NAME } from "@/lib/authCookies";
import { buildAuthCodeUrl, newFlowSecrets } from "@/server/auth/msal";
import {
  FLOW_COOKIE_MAX_AGE_S,
  cookiesSecure,
  serializeFlowSecrets,
} from "@/server/auth/flow";
import { apiErrorResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { state, nonce, codeVerifier, codeChallenge } = await newFlowSecrets();
    const authorizeUrl = await buildAuthCodeUrl({ state, nonce, codeChallenge });

    const res = NextResponse.redirect(authorizeUrl, 302);
    res.cookies.set(
      AUTH_FLOW_COOKIE_NAME,
      serializeFlowSecrets({ state, nonce, codeVerifier }),
      {
        httpOnly: true,
        secure: cookiesSecure(),
        sameSite: "lax",
        path: "/",
        maxAge: FLOW_COOKIE_MAX_AGE_S,
      }
    );
    return res;
  } catch (err) {
    return apiErrorResponse(err, "auth/login");
  }
}
