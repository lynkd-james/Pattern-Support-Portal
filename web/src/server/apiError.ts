// =============================================================================
// Sanitised API error responses (server-only, Stage 8a).
//
// Clients receive a GENERIC message only; the real error detail is logged
// server-side as structured JSON. Raw err.message must never reach the browser
// (verified leak pre-8a: Postgres relation errors surfaced to clients).
// UnauthenticatedError maps to the 401 envelope — this, not middleware, is the
// security boundary for API routes.
// =============================================================================

import { NextResponse } from "next/server";
import { createLogger } from "./logger";
import { UnauthenticatedError } from "./auth/errors";

const log = createLogger("api");

/** Uniform 401 for requests without a valid session. */
export function unauthenticatedResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: "UNAUTHENTICATED", message: "Authentication required." } },
    { status: 401 }
  );
}

/**
 * Map an unexpected route error to a client-safe envelope. `context` names the
 * route for the server-side log line.
 */
export function apiErrorResponse(err: unknown, context: string): NextResponse {
  if (err instanceof UnauthenticatedError) return unauthenticatedResponse();

  log.error("api_error", {
    context,
    reason: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "An unexpected error occurred." } },
    { status: 500 }
  );
}
