// =============================================================================
// Admin session resolution (Stage 10a) — the SECURITY BOUNDARY for /api/admin/*.
//
// Every admin API route calls requireAdminSession() before returning any
// data; no valid admin session → UnauthenticatedError (mapped to 401). This
// resolves ONLY the admin session store (admin cookie → admin_sessions →
// admin_users). A customer cookie is never consulted here, so a customer
// session cannot reach admin data — and the admin cookie is never consulted by
// the customer providers. Realm isolation is enforced at this layer, not by
// middleware (which is UX only).
// =============================================================================

import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE_NAME } from "@/lib/authCookies";
import { UnauthenticatedError } from "../auth/errors";
import { resolveAdminSession, type ResolvedAdminSession } from "./adminSessionStore";

export async function requireAdminSession(): Promise<ResolvedAdminSession> {
  const rawToken = cookies().get(ADMIN_SESSION_COOKIE_NAME)?.value;
  if (!rawToken) throw new UnauthenticatedError();
  const session = await resolveAdminSession(rawToken);
  if (!session) throw new UnauthenticatedError();
  return session;
}
