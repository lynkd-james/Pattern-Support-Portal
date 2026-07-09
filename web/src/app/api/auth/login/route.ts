// =============================================================================
// GET /api/auth/login — start the Microsoft Entra sign-in flow (customer realm).
// Thin route over the shared handler factory (auth/handlers.ts) + the customer
// realm; behaviour byte-for-byte the Stage 8a/8b/8c Entra flow.
// =============================================================================

import { makeLoginHandler } from "@/server/auth/handlers";
import { customerRealm } from "@/server/customer/authRealm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = makeLoginHandler(customerRealm, "entra");
