// =============================================================================
// GET /api/admin/auth/login — start the admin Entra sign-in flow (admin realm,
// separate single-tenant app). Thin route over the shared handler factory.
// =============================================================================

import { makeLoginHandler } from "@/server/auth/handlers";
import { adminRealm } from "@/server/admin/authRealm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = makeLoginHandler(adminRealm, "entra");
