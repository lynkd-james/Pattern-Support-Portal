// =============================================================================
// GET /api/auth/callback — complete the Microsoft Entra sign-in flow
// (customer realm). Thin route over the shared handler factory + customer
// realm: same validation order, failure surfaces, namespace pinning,
// once-only binding, session and audit semantics as before.
// =============================================================================

import { makeCallbackHandler } from "@/server/auth/handlers";
import { customerRealm } from "@/server/customer/authRealm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = makeCallbackHandler(customerRealm, "entra");
