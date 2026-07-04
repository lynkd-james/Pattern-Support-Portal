-- =============================================================================
-- 0001 — Stage 8a: Entra ID identity binding (tenant pinned at provisioning).
--
-- entra_tenant_id: the client's Entra tenant GUID, captured at PROVISIONING
--   time (never at login). First-login email matching requires the token's
--   `tid` to equal this value; a NULL tenant id means the user cannot log in.
--   Provisioning workflow: insert rows is_active = FALSE until the tenant GUID
--   is captured, then activate (db:verify enforces non-NULL on ACTIVE users).
-- entra_object_id: the Entra `oid`, bound on the first successful login. After
--   binding, (tid, oid) is the SOLE login key; email is never consulted again.
--
-- Written idempotently: no-ops on a fresh install whose schema.sql already
-- contains these columns.
-- =============================================================================

ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS entra_tenant_id TEXT;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS entra_object_id TEXT;

COMMENT ON COLUMN portal_users.entra_tenant_id IS
  'Entra tenant GUID captured at PROVISIONING time. Login requires token tid = this value. NULL = cannot log in (pending onboarding).';
COMMENT ON COLUMN portal_users.entra_object_id IS
  'Entra oid bound on first successful login; with entra_tenant_id it is the sole login key thereafter.';

-- One portal user per Entra identity (bound identities only).
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_users_entra_identity
  ON portal_users (entra_tenant_id, entra_object_id)
  WHERE entra_object_id IS NOT NULL;

-- Bound implies pinned: an oid binding without a provisioned tenant would
-- escape the partial unique index (NULLs are distinct in it) and the pinning
-- rule. DROP+ADD keeps this file idempotent (ADD CONSTRAINT has no IF NOT
-- EXISTS) and a no-op-equivalent on fresh installs where schema.sql defines it.
ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_entra_binding_chk;
ALTER TABLE portal_users ADD CONSTRAINT portal_users_entra_binding_chk CHECK (
  entra_object_id IS NULL OR entra_tenant_id IS NOT NULL
);

-- NOTE: magic_link_tokens is RETIRED as of Stage 8a (Entra ID replaces the
-- magic-link MVP design). The table is intentionally kept (never read/written).
