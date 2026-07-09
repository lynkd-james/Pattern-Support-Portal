// =============================================================================
// Page middleware — UX ONLY, never the security boundary (Amendment 2).
//
// Cookie-PRESENCE page redirects so users see a sign-in screen instead of a
// broken page. Two realms, each inspecting ONLY its own cookie (Stage 10a
// realm isolation — no shared branch, no cross-realm fallback):
//   * /dashboard, /  -> customer cookie -> /login
//   * /admin/*        -> admin cookie   -> /admin/login   (except /admin/login)
// Edge runtime has no DB; every API route re-resolves its realm's session
// server-side and returns 401 itself — that resolver, not this file, is the
// boundary.
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, ADMIN_SESSION_COOKIE_NAME } from "@/lib/authCookies";

function authEnabled(): boolean {
  const raw = (process.env.AUTH_ENABLED_PROVIDERS ?? process.env.AUTH_PROVIDER ?? "")
    .trim()
    .toLowerCase();
  return raw.length > 0 && !raw.includes("placeholder");
}

export function middleware(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();

  const path = req.nextUrl.pathname;

  // Admin realm: only the admin cookie is ever inspected here.
  if (path === "/admin" || path.startsWith("/admin/")) {
    if (path === "/admin/login") return NextResponse.next();
    if (!req.cookies.has(ADMIN_SESSION_COOKIE_NAME)) {
      return NextResponse.redirect(new URL("/admin/login", req.url));
    }
    return NextResponse.next();
  }

  // Customer realm: only the customer cookie is ever inspected here.
  if (!req.cookies.has(SESSION_COOKIE_NAME)) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/dashboard/:path*", "/admin/:path*"],
};
