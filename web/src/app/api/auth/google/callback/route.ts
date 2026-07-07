// =============================================================================
// GET /api/auth/google/callback — complete the Google Workspace sign-in flow.
// Thin route over the provider-independent handler factory (auth/handlers.ts):
// same validation order, failure surfaces, namespace pinning, once-only
// binding, session and audit semantics as the Entra flow.
// =============================================================================

import { makeCallbackHandler } from "@/server/auth/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = makeCallbackHandler("google");
