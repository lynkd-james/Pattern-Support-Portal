// =============================================================================
// GET /api/auth/callback — complete the Microsoft Entra sign-in flow.
// Thin route: the provider-independent flow lives in auth/handlers.ts
// (Stage 8c extraction; behaviour byte-for-byte the Stage 8a/8b Entra flow —
// validation order, failure surfaces, binding and audit semantics unchanged;
// see that module's header).
// =============================================================================

import { makeCallbackHandler } from "@/server/auth/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = makeCallbackHandler("entra");
