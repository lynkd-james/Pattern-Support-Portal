-- =============================================================================
-- 0002 — Stage 8b: provider-agnostic identity model (docs/identity-providers.md).
--
-- Replaces the Entra-specific identity columns with the approved neutral triple:
--   identity_provider   — which trust system authenticated the user
--   issuer_namespace    — provider-asserted organisational namespace, pinned at
--                         PROVISIONING (Entra: tenant GUID; Google: hd). The
--                         token's org claim must equal it before the identity
--                         is accepted. NULL = cannot log in (pending onboarding).
--   subject_identifier  — provider's immutable per-user id, bound at FIRST
--                         login; (provider, namespace, subject) is the sole
--                         login key thereafter.
--
-- Sequence: add -> backfill -> constrain -> index -> cleanup. Idempotent
-- (re-run = no-op) and fresh-install-safe: the backfill and legacy cleanup are
-- guarded so they no-op when the entra_* columns never existed (a fresh
-- schema.sql install has only the final form).
-- =============================================================================

-- 1. ADD ----------------------------------------------------------------------
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS identity_provider  TEXT NOT NULL DEFAULT 'entra';
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS issuer_namespace   TEXT;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS subject_identifier TEXT;

-- 2. BACKFILL (Stage 8a databases only; the DO-block guard makes this a no-op
--    on fresh installs where the legacy columns never existed) ----------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'portal_users'
       AND column_name = 'entra_tenant_id'
  ) THEN
    UPDATE portal_users
       SET identity_provider  = 'entra',
           issuer_namespace   = COALESCE(issuer_namespace,  entra_tenant_id),
           subject_identifier = COALESCE(subject_identifier, entra_object_id)
     WHERE entra_tenant_id IS NOT NULL OR entra_object_id IS NOT NULL;
  END IF;
END $$;

-- 3. CONSTRAIN ------------------------------------------------------------------
-- Provider values evolve by re-issuing this CHECK in a future migration
-- (TEXT + CHECK, not an enum: ALTER TYPE ... ADD VALUE cannot run inside the
-- runner's transaction).
ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_provider_chk;
ALTER TABLE portal_users ADD CONSTRAINT portal_users_provider_chk CHECK (
  identity_provider IN ('entra', 'google')
);

-- Bound implies pinned (generalises portal_users_entra_binding_chk).
ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_identity_binding_chk;
ALTER TABLE portal_users ADD CONSTRAINT portal_users_identity_binding_chk CHECK (
  subject_identifier IS NULL OR issuer_namespace IS NOT NULL
);

-- 4. INDEX ---------------------------------------------------------------------
-- One portal user per authenticated identity (bound identities only).
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_users_identity
  ON portal_users (identity_provider, issuer_namespace, subject_identifier)
  WHERE subject_identifier IS NOT NULL;

-- 5. CLEANUP (remove the legacy Entra-specific schema; decision 2: no legacy
--    columns are carried) -------------------------------------------------------
DROP INDEX IF EXISTS idx_portal_users_entra_identity;
ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_entra_binding_chk;
ALTER TABLE portal_users DROP COLUMN IF EXISTS entra_tenant_id;
ALTER TABLE portal_users DROP COLUMN IF EXISTS entra_object_id;

-- 6. DOCUMENT --------------------------------------------------------------------
COMMENT ON COLUMN portal_users.identity_provider IS
  'Trust system that authenticates this user (entra | google). Per-user provisioning data, not a tenancy attribute. The provider is not the organisation — the organisation boundary is issuer_namespace.';
COMMENT ON COLUMN portal_users.issuer_namespace IS
  'Provider-asserted organisational namespace pinned at PROVISIONING (Entra: tenant GUID; Google Workspace: hosted domain). Login requires the token''s org claim to equal this value. NULL = cannot log in (pending onboarding).';
COMMENT ON COLUMN portal_users.subject_identifier IS
  'Provider''s immutable per-user identifier, bound on first successful login (Entra: oid; Google: sub). (identity_provider, issuer_namespace, subject_identifier) is the sole login key thereafter; email is never consulted again.';
