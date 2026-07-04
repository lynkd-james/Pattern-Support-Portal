// =============================================================================
// Auth error types (server-only).
//
// UnauthenticatedError is the typed signal the session layer throws when a
// request carries no valid session. API routes map it to a 401 envelope via
// apiError.ts — it is the SECURITY BOUNDARY signal (middleware is UX only).
// =============================================================================

export class UnauthenticatedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}
