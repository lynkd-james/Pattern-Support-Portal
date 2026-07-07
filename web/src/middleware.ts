// =============================================================================
// Page middleware — UX ONLY, never the security boundary (Amendment 2).
//
// Redirects page loads without a session cookie to /login so users see the
// sign-in screen instead of a broken dashboard. It checks cookie PRESENCE only
// (edge runtime has no DB access) and no route trusts it: every API route
// resolves the session server-side via SessionProvider and returns 401 itself.
// Runs only when AUTH_PROVIDER=entra; matcher covers pages, never /api.
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/authCookies";

export function middleware(req: NextRequest) {
  // Active only when real auth is enabled (edge runtime: read env directly;
  // legacy AUTH_PROVIDER honoured until Stage 8d). Placeholder/no-auth => pass.
  const raw = (
    process.env.AUTH_ENABLED_PROVIDERS ??
    process.env.AUTH_PROVIDER ??
    ""
  )
    .trim()
    .toLowerCase();
  if (!raw || raw.includes("placeholder")) {
    return NextResponse.next();
  }
  if (!req.cookies.has(SESSION_COOKIE_NAME)) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/dashboard/:path*"],
};
