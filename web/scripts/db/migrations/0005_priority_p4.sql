-- =============================================================================
-- 0005 — P4 as a first-class support priority.
--
-- P4 = valid work intentionally OUTSIDE contractual SLA commitments (client
-- queries, module assistance, internal/administrative tickets, reminders).
-- P4 tickets sync, store, project and audit exactly like P1–P3.
--
-- Deliberately NO sla_policies row is seeded for P4: the SLA engine resolves
-- policies structurally, and "no matching policy" already yields
-- NOT_APPLICABLE with null due-times. The absence of a policy IS the business
-- rule (config is data); the engine is not special-cased.
--
-- ALTER TYPE ... ADD VALUE is transaction-safe on PostgreSQL 12+ provided the
-- new value is not used in the same transaction — this migration only adds it.
-- Idempotent via IF NOT EXISTS.
-- =============================================================================

ALTER TYPE priority_level ADD VALUE IF NOT EXISTS 'P4';
