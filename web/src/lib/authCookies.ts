// =============================================================================
// Auth cookie NAMES only (client-safe). Values are opaque random tokens set
// httpOnly by the server; nothing here is secret. Shared so the edge middleware
// (which must not import server modules) and the server session store agree.
// =============================================================================

/** Server-side session cookie (random token; SHA-256 stored in portal_sessions). */
export const SESSION_COOKIE_NAME = "pattern_portal_session";

/** Short-lived sign-in flow cookie (state + nonce + PKCE verifier). */
export const AUTH_FLOW_COOKIE_NAME = "pattern_auth_flow";
