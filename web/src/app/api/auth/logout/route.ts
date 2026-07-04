// =============================================================================
// POST /api/auth/logout — revoke the current session (Stage 8a).
//
// Sets portal_sessions.revoked_at (server-side kill; the cookie clear alone is
// never trusted) and clears the cookie. Idempotent; always lands on /login.
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/authCookies";
import { revokeSession } from "@/server/auth/sessionStore";
import { cookiesSecure } from "@/server/auth/flow";
import { apiErrorResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const rawToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (rawToken) await revokeSession(rawToken);

    const res = NextResponse.redirect(new URL("/login", req.url), 303);
    res.cookies.set(SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      secure: cookiesSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return res;
  } catch (err) {
    return apiErrorResponse(err, "auth/logout");
  }
}
