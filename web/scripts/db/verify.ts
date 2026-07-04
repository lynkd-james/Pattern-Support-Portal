// =============================================================================
// Read-only verification / read-back (Stage 1).
//
// Confirms the schema and seed are in the expected state. Performs SELECTs only
// — never writes. Exits non-zero if any check fails, so it can gate CI.
//
// Usage:  npm run db:verify        (run from the web/ directory)
// =============================================================================

import "dotenv/config";

import { env } from "../../src/server/env";
import { closePool, query } from "../../src/server/db";

const EXPECTED_EXTENSIONS = ["pgcrypto", "citext", "pg_trgm"];
const EXPECTED_ENUMS = [
  "priority_level",
  "portal_stage",
  "sla_state",
  "visibility_state",
  "audit_source",
  "sync_status",
];
const EXPECTED_TABLES = [
  "accounts",
  "business_units",
  "status_mappings",
  "sla_calendars",
  "sla_calendar_holidays",
  "sla_policies",
  "internal_tickets",
  "internal_ticket_events",
  "customer_tickets",
  "customer_ticket_timeline",
  "portal_users",
  "portal_user_business_units",
  "magic_link_tokens",
  "portal_sessions",
  "audit_events",
  "sync_runs",
];

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string) =>
  checks.push({ name, ok, detail });

async function presentSet(
  label: string,
  expected: string[],
  sql: string,
  col: string
): Promise<void> {
  const res = await query<Record<string, string>>(sql);
  const found = new Set(res.rows.map((r) => r[col]));
  const missing = expected.filter((e) => !found.has(e));
  record(label, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `all ${expected.length} present`);
}

async function expectCount(
  label: string,
  sql: string,
  expected: number
): Promise<void> {
  const res = await query<{ n: string }>(sql);
  const n = Number(res.rows[0]?.n ?? 0);
  record(label, n === expected, `expected ${expected}, found ${n}`);
}

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  await presentSet(
    "extensions",
    EXPECTED_EXTENSIONS,
    `SELECT extname FROM pg_extension WHERE extname = ANY('{${EXPECTED_EXTENSIONS.join(",")}}')`,
    "extname"
  );
  await presentSet(
    "enum types",
    EXPECTED_ENUMS,
    `SELECT typname FROM pg_type WHERE typname = ANY('{${EXPECTED_ENUMS.join(",")}}')`,
    "typname"
  );
  await presentSet(
    "tables",
    EXPECTED_TABLES,
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY('{${EXPECTED_TABLES.join(",")}}')`,
    "table_name"
  );

  // --- Tenancy structural invariants ---------------------------------------
  // Client-count-agnostic: these validate long-term schema/tenancy integrity so
  // onboarding the 19th/20th/50th client never requires editing validation.
  // They intentionally do NOT encode the current "one BU per account" business
  // choice (an account may legitimately gain sub-brand BUs later).

  await expectCount(
    "at least one active account (bootstrapped)",
    "SELECT count(*) AS n FROM (SELECT 1 FROM accounts WHERE is_active = TRUE LIMIT 1) t",
    1
  );
  await expectCount(
    "every active account has >= 1 active business unit",
    `SELECT count(*) AS n FROM accounts a
      WHERE a.is_active = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM business_units b
           WHERE b.account_id = a.id AND b.is_active = TRUE
        )`,
    0
  );
  await expectCount(
    "no active business unit under an inactive account",
    `SELECT count(*) AS n FROM business_units b
       JOIN accounts a ON a.id = b.account_id
      WHERE b.is_active = TRUE AND a.is_active = FALSE`,
    0
  );
  await expectCount(
    "no duplicate slug among active business units (attribution safety)",
    `SELECT count(*) AS n FROM (
       SELECT upper(slug) FROM business_units WHERE is_active = TRUE
       GROUP BY upper(slug) HAVING count(*) > 1
     ) d`,
    0
  );
  await expectCount(
    "legacy single-account model retired (no active 'pepkor')",
    "SELECT count(*) AS n FROM accounts WHERE slug = 'pepkor' AND is_active = TRUE",
    0
  );

  // --- Controlled config sets (deliberate, not client-growth-driven) --------
  await expectCount("status_mappings present", "SELECT count(*) AS n FROM status_mappings", 6);
  await expectCount("status_mappings all global", "SELECT count(*) AS n FROM status_mappings WHERE account_id IS NULL", 6);
  await expectCount("sla_calendars", "SELECT count(*) AS n FROM sla_calendars", 1);
  await expectCount("sla_policies (global P1-P3)", "SELECT count(*) AS n FROM sla_policies", 3);
  await expectCount("sla_policies all global", "SELECT count(*) AS n FROM sla_policies WHERE account_id IS NULL AND business_unit_id IS NULL", 3);

  // --- Portal auth structural invariants (Stage 8a) -------------------------
  // Scoped to ACTIVE users: an inactive row without a tenant GUID is a
  // legitimate onboarding state (provision inactive, activate once captured).

  await expectCount(
    "every active portal user has an entra_tenant_id",
    `SELECT count(*) AS n FROM portal_users
      WHERE is_active = TRUE AND entra_tenant_id IS NULL`,
    0
  );
  await expectCount(
    "no active portal user under an inactive account",
    `SELECT count(*) AS n FROM portal_users u
       JOIN accounts a ON a.id = u.account_id
      WHERE u.is_active = TRUE AND a.is_active = FALSE`,
    0
  );
  await expectCount(
    "every active non-account-wide portal user has >= 1 BU grant",
    `SELECT count(*) AS n FROM portal_users u
      WHERE u.is_active = TRUE AND u.account_wide = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM portal_user_business_units g WHERE g.user_id = u.id
        )`,
    0
  );
  await expectCount(
    "no BU grant crosses the user's account (tenancy isolation)",
    `SELECT count(*) AS n FROM portal_user_business_units g
       JOIN portal_users u ON u.id = g.user_id
       JOIN business_units b ON b.id = g.business_unit_id
      WHERE b.account_id <> u.account_id`,
    0
  );

  // Guard: confirm "business requirement" was NOT mapped (must quarantine).
  const br = await query<{ n: string }>(
    "SELECT count(*) AS n FROM status_mappings WHERE clickup_status = 'business requirement'"
  );
  record(
    "business requirement unmapped",
    Number(br.rows[0].n) === 0,
    Number(br.rows[0].n) === 0 ? "correctly absent" : "unexpectedly mapped"
  );

  // Report
  const pad = Math.max(...checks.map((c) => c.name.length));
  console.log("\nStage 1 verification\n────────────────────");
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(pad)}  ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log("────────────────────");
  console.log(`${checks.length - failed}/${checks.length} checks passed.\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[verify] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
