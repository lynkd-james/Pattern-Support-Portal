-- =============================================================================
-- 0003 — Stage 9a: shared tickets across customer accounts
-- (docs/shared-tickets.md, FROZEN design).
--
-- One canonical internal ticket; VISIBILITY lives exclusively in the new
-- junction (one row per visible business unit); the customer projection fans
-- out one row per (ticket x BU). internal_tickets.account_id/business_unit_id
-- are retained as ORIGIN: populated only when objectively real (single-BU
-- ticket), NULL for multi-BU tickets — origin is internal reporting data,
-- never a visibility input.
--
-- Sequence: create junction -> backfill -> relax origin NOT NULL -> global
-- ticket_number uniqueness -> per-(ticket x BU) customer uniqueness -> comments.
-- Idempotent (re-run = no-op) and fresh-install safe: schema.sql carries the
-- final form; every statement here no-ops against it.
-- =============================================================================

-- 1. VISIBILITY JUNCTION --------------------------------------------------------
CREATE TABLE IF NOT EXISTS internal_ticket_business_units (
  internal_ticket_id UUID NOT NULL REFERENCES internal_tickets(id) ON DELETE CASCADE,
  business_unit_id   UUID NOT NULL REFERENCES business_units(id)   ON DELETE RESTRICT,
  added_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (internal_ticket_id, business_unit_id)
);
CREATE INDEX IF NOT EXISTS idx_itbu_business_unit
  ON internal_ticket_business_units (business_unit_id);

-- 2. BACKFILL (existing single-BU tickets: one junction row each; idempotent
--    via ON CONFLICT; no-op on fresh installs with zero tickets) ----------------
INSERT INTO internal_ticket_business_units (internal_ticket_id, business_unit_id)
SELECT id, business_unit_id
  FROM internal_tickets
 WHERE business_unit_id IS NOT NULL
ON CONFLICT (internal_ticket_id, business_unit_id) DO NOTHING;

-- 3. ORIGIN becomes nullable (NULL = multi-BU / not applicable) ------------------
ALTER TABLE internal_tickets ALTER COLUMN account_id       DROP NOT NULL;
ALTER TABLE internal_tickets ALTER COLUMN business_unit_id DROP NOT NULL;

-- 4. ticket_number uniqueness becomes GLOBAL on the internal layer (the ClickUp
--    custom-id sequence is global; the per-account key no longer fits a ticket
--    with NULL origin) -----------------------------------------------------------
ALTER TABLE internal_tickets DROP CONSTRAINT IF EXISTS internal_tickets_account_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS internal_tickets_ticket_number_key
  ON internal_tickets (ticket_number);

-- 5. CUSTOMER projection: one row per (internal ticket x business unit) ----------
ALTER TABLE customer_tickets DROP CONSTRAINT IF EXISTS customer_tickets_internal_key;
ALTER TABLE customer_tickets DROP CONSTRAINT IF EXISTS customer_tickets_internal_bu_key;
ALTER TABLE customer_tickets ADD CONSTRAINT customer_tickets_internal_bu_key
  UNIQUE (internal_ticket_id, business_unit_id);

-- 6. DOCUMENT ---------------------------------------------------------------------
COMMENT ON TABLE internal_ticket_business_units IS
  'VISIBILITY set for a ticket — the SOLE source of which business units (and thus accounts) may see it. The customer projection fans out one customer_tickets row per member. Trust model: the ClickUp Customer label set IS the sharing decision (docs/shared-tickets.md).';
COMMENT ON COLUMN internal_tickets.account_id IS
  'ORIGIN account (internal reporting only, never visibility). NULL = multi-BU/shared ticket: no objectively correct origin exists in the source data, so none is fabricated.';
COMMENT ON COLUMN internal_tickets.business_unit_id IS
  'ORIGIN business unit (internal reporting only, never visibility). Non-NULL iff the visibility set has exactly one member, and then equals it (db:verify-enforced).';
