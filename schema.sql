-- =============================================================================
-- Pattern Support Portal — PostgreSQL Schema (V2, MVP)
--
-- End-to-end flow:
--   Outlook (support mailbox)
--     -> Intake automation (Power Automate / lightweight) -> ClickUp
--     -> Sync service -> PostgreSQL (INTERNAL store)
--     -> Transformation/projection layer -> PostgreSQL (CUSTOMER projection)
--     -> Read-only Customer Portal API
--
-- CORE ARCHITECTURAL RULE — DUAL LAYER:
--   * INTERNAL layer (internal_tickets, internal_ticket_events): full fidelity,
--     never exposed to customers. The sync service writes here.
--   * CUSTOMER layer (customer_tickets, customer_ticket_timeline): a SEPARATE
--     projection containing ONLY explicitly approved, customer-safe fields.
--     The portal API reads ONLY from this layer.
--   * There is NO direct field mapping or runtime masking from ClickUp to the
--     client view. Data crosses the boundary only via the transformation layer,
--     and only when visibility_state allows it.
--
-- Conventions: timestamptz in UTC; UUID PKs (non-enumerable); BIGINT identity on
-- append-only logs; soft-delete via deleted_at; account_id on customer-facing
-- tables to enable Row-Level Security.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram search on title / ticket_number

-- =============================================================================
-- ENUMERATED TYPES
-- =============================================================================

CREATE TYPE priority_level AS ENUM ('P1', 'P2', 'P3');

-- Normalised, customer-facing lifecycle stage. Raw ClickUp statuses map onto
-- these via status_mappings so internal taxonomy is never exposed.
CREATE TYPE portal_stage AS ENUM (
  'NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ON_HOLD',
  'BUSINESS_REVIEW', 'RESOLVED', 'CLOSED', 'REOPENED'
);

CREATE TYPE sla_state AS ENUM (
  'NOT_APPLICABLE', 'PENDING', 'AT_RISK', 'MET', 'BREACHED'
);

-- Controls whether/what an internal ticket is allowed to project to customers.
-- DEFAULT MUST ALWAYS BE internal_only.
CREATE TYPE visibility_state AS ENUM (
  'internal_only',        -- never projected (default)
  'ready_for_customer',   -- passed transformation, approved, staged (not yet live)
  'published',            -- live and visible in the portal
  'hidden_from_customer'  -- previously visible, explicitly retracted
);

CREATE TYPE audit_source AS ENUM ('SYNC', 'TRANSFORM', 'ADMIN', 'SYSTEM', 'PORTAL');
CREATE TYPE sync_status  AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- =============================================================================
-- TENANCY: ACCOUNTS and BUSINESS UNITS
-- Current model: each ClickUp Customer code is an independent client = one
-- account + one business_unit (slug = the ClickUp code). Umbrella groups
-- (Pepkor Speciality Group / L.A. Retail / Cape Union Mart International) are a
-- future account-grouping concern, not modelled yet. All isolation keys off
-- account_id + business_unit_id.
-- =============================================================================

CREATE TABLE accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,             -- short code, e.g. 'pepkor'; ticket_number prefix
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounts_slug_key UNIQUE (slug)
);

CREATE TABLE business_units (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_units_account_slug_key UNIQUE (account_id, slug)
);

-- =============================================================================
-- SYNC / TRANSFORMATION CONFIG
-- =============================================================================

-- Maps operator-configurable ClickUp statuses onto the fixed portal_stage enum,
-- and flags stages where the SLA clock pauses.
CREATE TABLE status_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID REFERENCES accounts(id) ON DELETE CASCADE, -- NULL = global default
  clickup_status  TEXT NOT NULL,
  portal_stage    portal_stage NOT NULL,
  is_sla_paused   BOOLEAN NOT NULL DEFAULT FALSE,
  display_label   TEXT,                  -- optional customer-friendly label
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT status_mappings_key UNIQUE (account_id, clickup_status)
);

-- =============================================================================
-- SLA CONFIGURATION (lightweight)
-- Calendar is optional (NULL policy.calendar_id => 24x7 wall-clock).
-- =============================================================================

CREATE TABLE sla_calendars (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  timezone       TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
  business_hours JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{day:1-7,start:'08:00',end:'17:00'}]
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sla_calendar_holidays (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id   UUID NOT NULL REFERENCES sla_calendars(id) ON DELETE CASCADE,
  holiday_date  DATE NOT NULL,
  description   TEXT,
  CONSTRAINT sla_calendar_holidays_key UNIQUE (calendar_id, holiday_date)
);

CREATE TABLE sla_policies (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 UUID REFERENCES accounts(id)       ON DELETE CASCADE, -- NULL = all accounts
  business_unit_id           UUID REFERENCES business_units(id) ON DELETE CASCADE, -- NULL = all BUs
  priority                   priority_level NOT NULL,
  calendar_id                UUID REFERENCES sla_calendars(id)  ON DELETE RESTRICT, -- NULL = 24x7
  response_target_minutes    INTEGER NOT NULL CHECK (response_target_minutes   > 0),
  resolution_target_minutes  INTEGER NOT NULL CHECK (resolution_target_minutes > 0),
  at_risk_threshold_pct      SMALLINT NOT NULL DEFAULT 80 CHECK (at_risk_threshold_pct BETWEEN 1 AND 100),
  is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from             TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to               TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sla_policies_scope_chk CHECK (business_unit_id IS NULL OR account_id IS NOT NULL)
);

-- =============================================================================
-- INTERNAL LAYER — system of record for support data (NEVER customer-facing).
-- Holds full-fidelity synced data + SLA computation + the visibility control.
-- customer_summary is the ONLY free-text field eligible to feed the projection
-- (an authored, customer-safe summary maintained in a dedicated ClickUp field).
-- =============================================================================

CREATE TABLE internal_tickets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ORIGIN (Stage 9a, docs/shared-tickets.md): internal reporting data only,
  -- NEVER a visibility input. Populated only when objectively real — i.e. the
  -- visibility set (junction below) has exactly one member, and then equals
  -- it. NULL = multi-BU/shared ticket (no origin is fabricated). Visibility
  -- comes exclusively from internal_ticket_business_units.
  account_id              UUID REFERENCES accounts(id)       ON DELETE RESTRICT,
  business_unit_id        UUID REFERENCES business_units(id) ON DELETE RESTRICT,

  -- Source linkage
  ticket_number           TEXT NOT NULL,           -- e.g. 'PEP-001234'
  clickup_task_id         TEXT NOT NULL,           -- idempotency key
  source_email_message_id TEXT,                    -- Outlook/Graph message id (intake)

  -- Full internal content (NOT projected as-is)
  title_internal          TEXT NOT NULL,
  description_internal    TEXT,
  requester_name          TEXT,
  requester_email         CITEXT,

  -- The ONLY authored field eligible to become the customer description
  customer_summary        TEXT,                    -- customer-safe summary (from dedicated ClickUp field)

  -- Classification / lifecycle
  priority                priority_level NOT NULL,
  current_stage           portal_stage   NOT NULL DEFAULT 'NEW',
  clickup_raw_status      TEXT,

  -- Visibility control (DEFAULT internal_only — the safe default)
  visibility_state        visibility_state NOT NULL DEFAULT 'internal_only',

  -- Milestone timestamps (derived from internal_ticket_events)
  created_at              TIMESTAMPTZ NOT NULL,
  acknowledged_at         TIMESTAMPTZ,
  business_review_at      TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  closed_at               TIMESTAMPTZ,

  -- SLA snapshot (computed internally)
  response_due_at         TIMESTAMPTZ,
  resolution_due_at       TIMESTAMPTZ,
  response_sla_state      sla_state NOT NULL DEFAULT 'NOT_APPLICABLE',
  resolution_sla_state    sla_state NOT NULL DEFAULT 'NOT_APPLICABLE',
  sla_paused_ms           BIGINT    NOT NULL DEFAULT 0,
  applied_sla_policy_id   UUID REFERENCES sla_policies(id) ON DELETE SET NULL,
  reopen_count            INTEGER   NOT NULL DEFAULT 0,

  -- Sync housekeeping
  content_hash            TEXT,
  last_synced_at          TIMESTAMPTZ,
  deleted_at              TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT internal_tickets_clickup_task_id_key UNIQUE (clickup_task_id),
  CONSTRAINT internal_tickets_ticket_number_key   UNIQUE (ticket_number),
  CONSTRAINT internal_tickets_milestone_chk CHECK (
    (acknowledged_at IS NULL OR acknowledged_at >= created_at) AND
    (resolved_at IS NULL OR closed_at IS NULL OR closed_at >= resolved_at)
  )
);

-- VISIBILITY set (Stage 9a): the SOLE source of which business units (and thus
-- accounts) may see a ticket. One canonical internal ticket, one row here per
-- visible BU; the customer projection fans out one customer_tickets row per
-- member. Trust model: the ClickUp Customer label set IS the sharing decision.
CREATE TABLE internal_ticket_business_units (
  internal_ticket_id UUID NOT NULL REFERENCES internal_tickets(id) ON DELETE CASCADE,
  business_unit_id   UUID NOT NULL REFERENCES business_units(id)   ON DELETE RESTRICT,
  added_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (internal_ticket_id, business_unit_id)
);

-- Canonical, append-only lifecycle timeline (internal source of truth).
CREATE TABLE internal_ticket_events (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  internal_ticket_id  UUID NOT NULL REFERENCES internal_tickets(id) ON DELETE CASCADE,
  from_stage          portal_stage,
  to_stage            portal_stage NOT NULL,
  from_raw_status     TEXT,
  to_raw_status       TEXT,
  is_customer_visible BOOLEAN NOT NULL DEFAULT FALSE, -- whether this event may project to the timeline
  changed_at          TIMESTAMPTZ NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source              audit_source NOT NULL DEFAULT 'SYNC'
);

-- =============================================================================
-- CUSTOMER LAYER — the ONLY data the portal API reads.
-- Populated exclusively by the transformation layer. Contains only the agreed
-- customer-safe fields. Portal lists/serves rows WHERE visibility_state='published'.
-- =============================================================================

CREATE TABLE customer_tickets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Internal linkage (never exposed via the API)
  internal_ticket_id   UUID NOT NULL REFERENCES internal_tickets(id) ON DELETE CASCADE,

  -- Tenancy (denormalised for isolation + RLS)
  account_id           UUID NOT NULL REFERENCES accounts(id)       ON DELETE RESTRICT,
  business_unit_id     UUID NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,

  -- Approved customer-safe fields ONLY
  ticket_number        TEXT NOT NULL,
  title                TEXT NOT NULL,     -- sanitised
  description          TEXT,              -- customer-safe (from internal.customer_summary)
  priority             priority_level NOT NULL,
  stage                portal_stage   NOT NULL,

  -- Timestamps (customer-facing milestones)
  created_at           TIMESTAMPTZ NOT NULL,
  acknowledged_at      TIMESTAMPTZ,
  business_review_at   TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  closed_at            TIMESTAMPTZ,

  -- SLA (safe subset)
  response_due_at      TIMESTAMPTZ,
  resolution_due_at    TIMESTAMPTZ,
  response_sla_state   sla_state NOT NULL DEFAULT 'NOT_APPLICABLE',
  resolution_sla_state sla_state NOT NULL DEFAULT 'NOT_APPLICABLE',

  -- Projection control (mirrors internal control; portal filters on 'published')
  visibility_state     visibility_state NOT NULL DEFAULT 'published',
  published_at         TIMESTAMPTZ,
  last_projected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One projection row per (canonical ticket x visible BU) — Stage 9a fan-out.
  CONSTRAINT customer_tickets_internal_bu_key UNIQUE (internal_ticket_id, business_unit_id),
  CONSTRAINT customer_tickets_account_number_key UNIQUE (account_id, ticket_number),
  -- Defence-in-depth: only ever live or retracted rows belong in the projection.
  CONSTRAINT customer_tickets_visibility_chk CHECK (
    visibility_state IN ('published', 'hidden_from_customer')
  )
);

-- Filtered, customer-safe timeline derived from internal_ticket_events.
CREATE TABLE customer_ticket_timeline (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_ticket_id UUID NOT NULL REFERENCES customer_tickets(id) ON DELETE CASCADE,
  stage              portal_stage NOT NULL,
  label              TEXT,            -- customer-friendly label
  occurred_at        TIMESTAMPTZ NOT NULL,
  projected_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- AUTHENTICATION — provider-agnostic identity model (Stage 8b; see
-- docs/identity-providers.md). The identity provider authenticates; the
-- portal DB authorises. Every identity is the triple
--   (identity_provider, issuer_namespace, subject_identifier):
-- the namespace is pinned at PROVISIONING (Entra: tenant GUID; Google
-- Workspace: hosted domain), the subject is bound at FIRST login, and the
-- triple is the sole login key thereafter. The provider is NOT the
-- organisation — the organisation boundary is issuer_namespace. Sessions are
-- server-side rows; raw tokens are NEVER stored, only SHA-256 hashes. All
-- authorization is enforced at the data layer (account/BU scope below).
-- NOTE: magic_link_tokens below is RETIRED (pre-Entra MVP design; kept, unused).
-- =============================================================================

CREATE TABLE portal_users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  email              CITEXT NOT NULL,
  display_name       TEXT,
  account_wide       BOOLEAN NOT NULL DEFAULT FALSE, -- true => all BUs in account; else use grants below
  -- Provider-agnostic identity (Stage 8b). issuer_namespace is captured at
  -- PROVISIONING time (NULL = cannot log in; provision inactive until
  -- captured); subject_identifier is bound on first successful login.
  identity_provider  TEXT NOT NULL DEFAULT 'entra',
  issuer_namespace   TEXT,
  subject_identifier TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT portal_users_email_key UNIQUE (email),
  -- TEXT + CHECK (not enum): provider values evolve by re-issuing this CHECK
  -- in a transactional migration.
  CONSTRAINT portal_users_provider_chk CHECK (
    identity_provider IN ('entra', 'google')
  ),
  -- Bound implies pinned: a subject binding without a provisioned namespace
  -- would escape the partial unique index (NULLs are distinct) and the
  -- pinning rule.
  CONSTRAINT portal_users_identity_binding_chk CHECK (
    subject_identifier IS NULL OR issuer_namespace IS NOT NULL
  )
);

-- Explicit per-BU grants for users that are not account_wide.
CREATE TABLE portal_user_business_units (
  user_id          UUID NOT NULL REFERENCES portal_users(id)   ON DELETE CASCADE,
  business_unit_id UUID NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, business_unit_id)
);

-- One-time magic-link tokens (hashed). Single-use, short TTL.
CREATE TABLE magic_link_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,         -- SHA-256 of the emailed token
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  requested_ip  INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT magic_link_tokens_hash_key UNIQUE (token_hash)
);

-- Server-side sessions established after a magic link is consumed.
CREATE TABLE portal_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL,    -- SHA-256 of the session cookie value
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ,
  user_agent         TEXT,
  ip                 INET,
  CONSTRAINT portal_sessions_hash_key UNIQUE (session_token_hash)
);

-- =============================================================================
-- ADMIN REALM (Stage 10a; see docs/admin-portal.md). Staff identities +
-- sessions, FULLY ISOLATED from the customer identities above. Same
-- provider-agnostic trust model (identity triple, namespace pinned at
-- provisioning, subject bound at first login, deny-by-default) — separate
-- table, separate session store, separate cookie (pattern_admin_session).
-- Admin login uses a SEPARATE single-tenant Entra app. The first admin is
-- inserted by scripts/admin/bootstrap.ts; NEVER auto-promoted by domain/tenant.
-- =============================================================================

CREATE TABLE admin_users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              CITEXT NOT NULL,
  display_name       TEXT,
  identity_provider  TEXT NOT NULL DEFAULT 'entra',
  issuer_namespace   TEXT,             -- pinned at provisioning (Pattern tenant)
  subject_identifier TEXT,             -- bound at first login
  role               TEXT NOT NULL DEFAULT 'admin',  -- single role in V1; extensible without migration
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_users_email_key UNIQUE (email),
  CONSTRAINT admin_users_provider_chk CHECK (identity_provider IN ('entra', 'google')),
  CONSTRAINT admin_users_identity_binding_chk CHECK (
    subject_identifier IS NULL OR issuer_namespace IS NOT NULL
  )
);

CREATE TABLE admin_sessions (
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

-- =============================================================================
-- AUDIT & OBSERVABILITY
-- =============================================================================

-- Append-only audit of every meaningful change (incl. visibility transitions
-- and projection events — critical for proving what was shown to a customer).
CREATE TABLE audit_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type   TEXT NOT NULL,         -- 'internal_ticket' | 'customer_ticket' | 'portal_user' | ...
  entity_id     UUID NOT NULL,
  account_id    UUID REFERENCES accounts(id) ON DELETE SET NULL,
  field         TEXT,
  old_value     JSONB,
  new_value     JSONB,
  change_source audit_source NOT NULL,
  actor         TEXT,                  -- user email / 'sync' / 'transform' / 'system'
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sync_runs (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system    TEXT NOT NULL,      -- 'clickup' | 'outlook' | 'transform' | 'sla' | 'sessions'
  status           sync_status NOT NULL DEFAULT 'RUNNING',
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  tickets_seen     INTEGER NOT NULL DEFAULT 0,
  tickets_upserted INTEGER NOT NULL DEFAULT 0,
  error_count      INTEGER NOT NULL DEFAULT 0,
  cursor           TEXT,               -- incremental/delta cursor
  details          JSONB
);

-- =============================================================================
-- INDEXING STRATEGY
-- =============================================================================

-- Tenancy
CREATE INDEX idx_business_units_account ON business_units (account_id);

-- INTERNAL: sync/reconciliation + transformation candidate selection
CREATE INDEX idx_itbu_business_unit ON internal_ticket_business_units (business_unit_id);
CREATE INDEX idx_internal_tickets_last_synced ON internal_tickets (last_synced_at);
CREATE INDEX idx_internal_tickets_visibility
  ON internal_tickets (visibility_state)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_internal_events_ticket ON internal_ticket_events (internal_ticket_id, changed_at);

-- CUSTOMER PROJECTION: portal read paths (only published rows matter)
CREATE INDEX idx_customer_tickets_bu_created
  ON customer_tickets (business_unit_id, created_at DESC)
  WHERE visibility_state = 'published';
CREATE INDEX idx_customer_tickets_account_stage
  ON customer_tickets (account_id, stage, created_at DESC)
  WHERE visibility_state = 'published';
CREATE INDEX idx_customer_tickets_resolution_due
  ON customer_tickets (resolution_due_at)
  WHERE visibility_state = 'published'
    AND resolution_sla_state IN ('PENDING', 'AT_RISK');
CREATE INDEX idx_customer_tickets_title_trgm  ON customer_tickets USING gin (title gin_trgm_ops);
CREATE INDEX idx_customer_tickets_number_trgm ON customer_tickets USING gin (ticket_number gin_trgm_ops);
CREATE INDEX idx_customer_timeline_ticket ON customer_ticket_timeline (customer_ticket_id, occurred_at);

-- AUTH
CREATE UNIQUE INDEX idx_portal_users_identity
  ON portal_users (identity_provider, issuer_namespace, subject_identifier)
  WHERE subject_identifier IS NOT NULL;
CREATE INDEX idx_portal_user_bu_user ON portal_user_business_units (user_id);
CREATE INDEX idx_magic_tokens_user   ON magic_link_tokens (user_id, expires_at);
CREATE INDEX idx_portal_sessions_user
  ON portal_sessions (user_id)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX idx_admin_users_identity
  ON admin_users (identity_provider, issuer_namespace, subject_identifier)
  WHERE subject_identifier IS NOT NULL;
CREATE INDEX idx_admin_sessions_user
  ON admin_sessions (admin_user_id)
  WHERE revoked_at IS NULL;

-- AUDIT
CREATE INDEX idx_audit_entity  ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX idx_audit_account ON audit_events (account_id, occurred_at DESC);

-- CONFIG resolution
CREATE INDEX idx_sla_policies_scope     ON sla_policies (priority, account_id, business_unit_id) WHERE is_active = TRUE;
CREATE INDEX idx_status_mappings_lookup ON status_mappings (account_id, clickup_status);
