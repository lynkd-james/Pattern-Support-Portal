-- =============================================================================
-- 0004 — Stage 10a: admin identity realm (docs/admin-portal.md).
--
-- A SEPARATE staff identity + session realm, fully isolated from the customer
-- identities (portal_users / portal_sessions). Same provider-agnostic trust
-- model (identity triple, namespace pinned at provisioning, subject bound at
-- first login, deny-by-default) — a separate table, a separate session store,
-- a separate cookie. Admins are Pattern staff; the first admin is inserted by
-- the bootstrap script (never auto-promoted by domain/tenant).
--
-- Written idempotently; no-ops on a fresh install whose schema.sql already
-- contains these tables.
-- =============================================================================

-- ADMIN USERS ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              CITEXT NOT NULL,
  display_name       TEXT,
  -- Provider-agnostic identity (reuses the Stage 8b vocabulary). Admin login
  -- uses a SEPARATE single-tenant Entra app; issuer_namespace pins to
  -- Pattern's tenant, captured at provisioning (NULL = cannot log in).
  identity_provider  TEXT NOT NULL DEFAULT 'entra',
  issuer_namespace   TEXT,
  subject_identifier TEXT,
  -- Single role in V1; column present so support/operations/readonly/
  -- superadmin can be added later WITHOUT a migration.
  role               TEXT NOT NULL DEFAULT 'admin',
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_users_email_key UNIQUE (email),
  CONSTRAINT admin_users_provider_chk CHECK (identity_provider IN ('entra', 'google')),
  -- Bound implies pinned (mirrors portal_users_identity_binding_chk).
  CONSTRAINT admin_users_identity_binding_chk CHECK (
    subject_identifier IS NULL OR issuer_namespace IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_identity
  ON admin_users (identity_provider, issuer_namespace, subject_identifier)
  WHERE subject_identifier IS NOT NULL;

COMMENT ON TABLE admin_users IS
  'Staff identities for the admin portal (Stage 10a) — fully separate from portal_users. Authentication proves identity; a row here grants administrator authority. Never auto-populated by domain/tenant; the first admin is inserted by scripts/admin/bootstrap.ts.';

-- ADMIN SESSIONS (structurally identical to portal_sessions, separate table) ---
CREATE TABLE IF NOT EXISTS admin_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id      UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL,    -- SHA-256 of the admin session cookie value
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ,
  user_agent         TEXT,
  ip                 INET,
  CONSTRAINT admin_sessions_hash_key UNIQUE (session_token_hash)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
  ON admin_sessions (admin_user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE admin_sessions IS
  'DB-backed admin sessions (Stage 10a). Distinct cookie (pattern_admin_session) + distinct table from portal_sessions => a customer session can never authenticate to admin and vice versa (realm isolation is structural).';
