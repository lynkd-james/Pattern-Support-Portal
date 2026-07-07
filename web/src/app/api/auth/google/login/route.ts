// =============================================================================
// GET /api/auth/google/login — start the Google Workspace sign-in flow.
// Thin route over the provider-independent handler factory (auth/handlers.ts).
// =============================================================================

import { makeLoginHandler } from "@/server/auth/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = makeLoginHandler("google");
