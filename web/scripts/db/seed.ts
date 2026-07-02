// =============================================================================
// Idempotent reference-data seed.
//
// Tenancy model: each ClickUp customer code is an independent CLIENT = its own
// account, with ONE business unit (1:1). The business_unit.slug is the ClickUp
// `Customer` label (the sync's attribution key). Status mappings are GLOBAL
// (account_id = NULL) so one deterministic map applies to every client.
//
// Seeds (idempotent, re-runnable):
//   * accounts        — one per client (18)
//   * business_units  — one per client; slug = ClickUp customer code
//   * status_mappings — global (account_id = NULL); replaces any prior rows
//   * sla_calendars   — one Africa/Johannesburg scaffold
//   * sla_policies    — DELIBERATELY NONE (await real targets)
//
// Migration: the legacy single "pepkor" account + its brand BUs are RETIRED by
// setting is_active = FALSE (non-destructive). loadBuBySlug()/session both filter
// WHERE is_active = TRUE, so retired rows drop out of attribution and scope and
// their slugs (TTOWN, DUNNS, …) no longer collide with the per-client BUs.
//
// Deliberately NOT mapped: "business requirement" (quarantines until confirmed).
// Native ClickUp priority is ignored; priority comes from the SLA Priority field.
//
// SCOPE — BOOTSTRAP ONLY. This seed establishes the CURRENTLY-supported clients.
// It is NOT the exhaustive/permanent client list, and the runtime never depends
// on it (the resolver reads business_units live). Onboard FUTURE clients via a
// migration or an administrative INSERT into accounts + business_units
// (slug = ClickUp customer code) — the sync/resolver pick them up automatically,
// and any not-yet-onboarded code deterministically quarantines as BU_UNDETERMINED.
// Retire a client with is_active = FALSE (preserves historical data). Do not
// treat continual edits to this file as the client-onboarding mechanism.
//
// Usage:  npm run db:seed         (run from the web/ directory)
// =============================================================================

import "dotenv/config";

import { env } from "../../src/server/env";
import { closePool, withTransaction } from "../../src/server/db";
import type { PoolClient } from "pg";

const LEGACY_ACCOUNT_SLUG = "pepkor";

// One account per client. `code` is the ClickUp `Customer` label = business_unit.slug
// (the sync's attribution key). Add a client by adding a row here — no code change.
const CLIENTS: ReadonlyArray<{ name: string; accountSlug: string; code: string }> = [
  { name: "Pick n Pay Clothing", accountSlug: "pnp", code: "PnP" },
  { name: "Freedom of Movement", accountSlug: "fom", code: "FOM" },
  { name: "Boardriders", accountSlug: "brd", code: "BRD" },
  { name: "Woolworths", accountSlug: "ww", code: "WW" },
  { name: "Clothing Junction", accountSlug: "cjn", code: "CJN" },
  { name: "LA Retail", accountSlug: "lar", code: "LAR" },
  { name: "Polo Distribution", accountSlug: "pol", code: "POL" },
  { name: "SPCC", accountSlug: "spcc", code: "SPCC" },
  { name: "Dunn's", accountSlug: "dunns", code: "DUNNS" },
  { name: "Cape Union Mart", accountSlug: "cumi", code: "CUMI" },
  { name: "Old Khaki", accountSlug: "old-khaki", code: "Old Khaki" },
  { name: "Poetry", accountSlug: "poetry", code: "Poetry" },
  { name: "Tekkie Town", accountSlug: "ttown", code: "TTOWN" },
  { name: "Refinery", accountSlug: "rfry", code: "RFRY" },
  { name: "Ayana", accountSlug: "ayn", code: "AYN" },
  { name: "Hertex", accountSlug: "hrtx", code: "HRTX" },
  { name: "Code", accountSlug: "code", code: "CODE" },
  { name: "Superbalist", accountSlug: "sup", code: "SUP" },
];

// Confirmed deterministic status map (one ClickUp status -> one portal stage).
// "business requirement" intentionally absent -> quarantine until confirmed.
const STATUS_MAPPINGS: ReadonlyArray<{
  clickup_status: string;
  portal_stage: string;
  is_sla_paused: boolean;
}> = [
  { clickup_status: "to do", portal_stage: "NEW", is_sla_paused: false },
  { clickup_status: "in progress", portal_stage: "IN_PROGRESS", is_sla_paused: false },
  { clickup_status: "in review", portal_stage: "IN_PROGRESS", is_sla_paused: false },
  { clickup_status: "business review", portal_stage: "BUSINESS_REVIEW", is_sla_paused: false },
  { clickup_status: "done", portal_stage: "CLOSED", is_sla_paused: false },
  { clickup_status: "cancelled", portal_stage: "CLOSED", is_sla_paused: false },
];

const SLA_CALENDAR = {
  name: "Pattern Support — Africa/Johannesburg (Mon–Fri 08:00–17:00)",
  timezone: "Africa/Johannesburg",
  business_hours: [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "17:00" })),
};

/** Upsert 18 client accounts, each with one business unit (slug = ClickUp code). */
async function seedClients(client: PoolClient): Promise<{ accounts: number; bus: number }> {
  let accounts = 0;
  let bus = 0;
  for (const c of CLIENTS) {
    const acc = await client.query<{ id: string }>(
      `INSERT INTO accounts (name, slug, is_active)
         VALUES ($1, $2, TRUE)
       ON CONFLICT (slug)
         DO UPDATE SET name = EXCLUDED.name, is_active = TRUE, updated_at = now()
       RETURNING id`,
      [c.name, c.accountSlug]
    );
    const accountId = acc.rows[0].id;
    accounts += 1;

    await client.query(
      `INSERT INTO business_units (account_id, name, slug, is_active)
         VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (account_id, slug)
         DO UPDATE SET name = EXCLUDED.name, is_active = TRUE, updated_at = now()`,
      [accountId, c.name, c.code]
    );
    bus += 1;
  }
  return { accounts, bus };
}

/** Retire the legacy single-account model (non-destructive: is_active = FALSE). */
async function retireLegacyAccount(client: PoolClient): Promise<boolean> {
  const res = await client.query<{ id: string }>(
    `UPDATE accounts SET is_active = FALSE, updated_at = now()
      WHERE slug = $1 AND is_active = TRUE
      RETURNING id`,
    [LEGACY_ACCOUNT_SLUG]
  );
  if (res.rowCount === 0) return false;
  await client.query(
    `UPDATE business_units SET is_active = FALSE, updated_at = now() WHERE account_id = $1`,
    [res.rows[0].id]
  );
  return true;
}

/** Global status mappings (account_id = NULL). Replace-style: NULL can't use ON CONFLICT. */
async function seedGlobalStatusMappings(client: PoolClient): Promise<number> {
  await client.query("DELETE FROM status_mappings");
  let n = 0;
  for (const m of STATUS_MAPPINGS) {
    await client.query(
      `INSERT INTO status_mappings (account_id, clickup_status, portal_stage, is_sla_paused)
         VALUES (NULL, $1, $2::portal_stage, $3)`,
      [m.clickup_status, m.portal_stage, m.is_sla_paused]
    );
    n += 1;
  }
  return n;
}

async function seedSlaCalendar(client: PoolClient): Promise<number> {
  const exists = await client.query("SELECT 1 FROM sla_calendars WHERE name = $1", [
    SLA_CALENDAR.name,
  ]);
  if (exists.rowCount) return 0;
  await client.query(
    `INSERT INTO sla_calendars (name, timezone, business_hours)
       VALUES ($1, $2, $3::jsonb)`,
    [SLA_CALENDAR.name, SLA_CALENDAR.timezone, JSON.stringify(SLA_CALENDAR.business_hours)]
  );
  return 1;
}

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  const summary = await withTransaction(async (client) => {
    const { accounts, bus } = await seedClients(client);
    const legacyRetired = await retireLegacyAccount(client);
    const smCount = await seedGlobalStatusMappings(client);
    const calInserted = await seedSlaCalendar(client);
    return { accounts, bus, legacyRetired, smCount, calInserted };
  });

  console.log("[seed] client accounts   :", summary.accounts, "upserted (each active)");
  console.log("[seed] business_units    :", summary.bus, "upserted (slug = ClickUp code)");
  console.log(
    "[seed] legacy 'pepkor'   :",
    summary.legacyRetired ? "retired (is_active = FALSE)" : "not present"
  );
  console.log("[seed] status_mappings   :", summary.smCount, "global (account_id = NULL); 'business requirement' unmapped");
  console.log("[seed] sla_calendars     :", summary.calInserted === 1 ? "1 inserted" : "already present");
  console.log("[seed] sla_policies      : 0 (intentionally none — awaiting real targets)");
  console.log("[seed] done.");
}

main()
  .catch((err) => {
    console.error("[seed] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
