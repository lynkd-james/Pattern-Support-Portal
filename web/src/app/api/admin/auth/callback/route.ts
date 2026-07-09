// =============================================================================
// GET /api/admin/auth/callback — complete the admin Entra sign-in flow (admin
// realm). Same orchestration as the customer callback via the shared factory;
// the admin realm supplies the admin app, admin_users lookup/bind, admin
// session + cookie, and admin audit. A customer flow cookie is rejected
// (realm_mismatch_cookie).
// =============================================================================

import { makeCallbackHandler } from "@/server/auth/handlers";
import { adminRealm } from "@/server/admin/authRealm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = makeCallbackHandler(adminRealm, "entra");
