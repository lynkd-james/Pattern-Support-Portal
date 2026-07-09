// =============================================================================
// Auth cookie NAMES only (client-safe). Values are opaque random tokens set
// httpOnly by the server; nothing here is secret. Shared so the edge middleware
// (which must not import server modules) and the server session store agree.
// =============================================================================

/** Customer session cookie (random token; SHA-256 stored in portal_sessions). */
export const SESSION_COOKIE_NAME = "pattern_portal_session";

/** Admin session cookie (Stage 10a; SHA-256 stored in admin_sessions). Distinct
 *  from the customer cookie — realm isolation is structural, not policed. */
export const ADMIN_SESSION_COOKIE_NAME = "pattern_admin_session";

/** Short-lived sign-in flow cookie (state + nonce + PKCE verifier; shared, but
 *  carries the realm + provider so a callback rejects a cross-realm cookie). */
export const AUTH_FLOW_COOKIE_NAME = "pattern_auth_flow";
