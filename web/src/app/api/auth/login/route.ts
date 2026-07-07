// =============================================================================
// GET /api/auth/login — start the Entra sign-in flow.
//
// Stage 8b: provider-agnostic handler driving an IdentityProviderAdapter
// (Entra wired on this route; Google gets a parallel route in Stage 8c).
// Generates per-flow secrets (CSRF state, ID-token nonce, PKCE verifier) and
// records the flow's PROVIDER in the short-lived httpOnly cookie so the
// callback can reject cross-flow replays. The post-login target is FIXED to
// /dashboard — no return-URL parameter exists anywhere in the flow.
// =============================================================================

import { NextResponse } from "next/server";
import { AUTH_FLOW_COOKIE_NAME } from "@/lib/authCookies";
import { getAdapter } from "@/server/auth/provider";
import {
  FLOW_COOKIE_MAX_AGE_S,
  cookiesSecure,
  newFlowSecrets,
  serializeFlowSecrets,
} from "@/server/auth/flow";
import { apiErrorResponse } from "@/server/apiError";
import type { IdentityProviderId } from "@/server/auth/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The provider this route serves. Stage 8c adds a parallel Google route. */
const ROUTE_PROVIDER: IdentityProviderId = "entra";

export async function GET() {
  try {
    const { provider, state, nonce, codeVerifier, codeChallenge } =
      newFlowSecrets(ROUTE_PROVIDER);
    const authorizeUrl = await getAdapter(ROUTE_PROVIDER).buildAuthUrl({
      state,
      nonce,
      codeChallenge,
    });

    const res = NextResponse.redirect(authorizeUrl, 302);
    res.cookies.set(
      AUTH_FLOW_COOKIE_NAME,
      serializeFlowSecrets({ provider, state, nonce, codeVerifier }),
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
