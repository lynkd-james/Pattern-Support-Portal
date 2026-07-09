// =============================================================================
// POST /api/admin/auth/logout — revoke the current admin session (Stage 10a).
// Server-side revoke (the cookie clear alone is never trusted) + clear cookie;
// idempotent; lands on /admin/login.
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE_NAME } from "@/lib/authCookies";
import { cookiesSecure } from "@/server/auth/flow";
import { revokeAdminSession } from "@/server/admin/adminSessionStore";
import { apiErrorResponse } from "@/server/apiError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const rawToken = req.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value;
    if (rawToken) await revokeAdminSession(rawToken);

    const res = NextResponse.redirect(new URL("/admin/login", req.url), 303);
    res.cookies.set(ADMIN_SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      secure: cookiesSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return res;
  } catch (err) {
    return apiErrorResponse(err, "admin/auth/logout");
  }
}
