// =============================================================================
// GET /api/auth/google/callback — complete the Google Workspace sign-in flow
// (customer realm). Thin route over the shared handler factory + customer realm.
// =============================================================================

import { makeCallbackHandler } from "@/server/auth/handlers";
import { customerRealm } from "@/server/customer/authRealm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = makeCallbackHandler(customerRealm, "google");
