// =============================================================================
// Read-only production-readiness env check (Stage 10 / Phase 1 ops helper).
//
// Reports per-subsystem configuration readiness by reusing env.ts's own
// require* accessors (never duplicates validation, never prints secret VALUES —
// only set/missing and the enabled-provider set). Exits non-zero if any
// subsystem needed for the CURRENT AUTH_ENABLED_PROVIDERS / enabled features is
// missing config, so it can gate a deploy. Does NOT connect to anything.
//
// Usage:  npm run env:check        (run from the web/ directory)
// =============================================================================

import "dotenv/config";

import {
  env,
  requireDatabaseUrl,
  requireClickup,
  requireClickupScope,
  requireGraph,
  requirePortalAuth,
  requireGoogleAuth,
} from "../../src/server/env";

type Row = { subsystem: string; ok: boolean; detail: string };
const rows: Row[] = [];
const check = (subsystem: string, fn: () => void, opts: { required: boolean }) => {
  try {
    fn();
    rows.push({ subsystem, ok: true, detail: "configured" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    rows.push({
      subsystem,
      ok: !opts.required,
      detail: `${opts.required ? "MISSING" : "not set (optional here)"}: ${msg.replace(/\.\s*See.*$/, "")}`,
    });
  }
};

const providers = env.enabledProviders;
const entraOn = providers.includes("entra");
const googleOn = providers.includes("google");

check("Database (DATABASE_URL)", () => void requireDatabaseUrl(), { required: true });
check("ClickUp token", () => void requireClickup(), { required: true });
check("ClickUp scope (TEAM/FOLDER)", () => void requireClickupScope(), { required: true });
check("Microsoft Graph (Outlook)", () => void requireGraph(), { required: true });
check("Auth: Entra", () => void requirePortalAuth(), { required: entraOn });
check("Auth: Google", () => void requireGoogleAuth(), { required: googleOn });
check("Jobs: CRON_SECRET", () => {
  if (!env.cronSecret) throw new Error("CRON_SECRET is not set (scheduled jobs fail closed)");
}, { required: true });

// Non-secret config surface worth eyeballing before a deploy.
const notes: string[] = [
  `NODE_ENV=${env.nodeEnv}`,
  `AUTH_ENABLED_PROVIDERS=${providers.join(",")}`,
  `AUTO_PUBLISH_ENABLED=${env.autoPublishEnabled}`,
  `CLICKUP_SLA_PRIORITY_FIELD_NAME=${env.clickupSlaPriorityFieldName}`,
  `CLICKUP_CUSTOMER_FIELD_NAME=${env.clickupCustomerFieldName}`,
  `SESSION_IDLE_HOURS=${env.sessionIdleHours} SESSION_MAX_HOURS=${env.sessionMaxHours}`,
];

const pad = Math.max(...rows.map((r) => r.subsystem.length));
console.log("\nProduction env readiness\n────────────────────────");
for (const r of rows) console.log(`${r.ok ? "OK  " : "FAIL"}  ${r.subsystem.padEnd(pad)}  ${r.detail}`);
console.log("────────────────────────");
for (const n of notes) console.log(`  · ${n}`);
if (env.clickupSlaPriorityFieldName === "SLA Priority") {
  console.log(
    "\n  ⚠ CLICKUP_SLA_PRIORITY_FIELD_NAME defaults to 'SLA Priority'. If the\n" +
      "    ClickUp field is named 'SLA', set CLICKUP_SLA_PRIORITY_FIELD_NAME=SLA or\n" +
      "    every ticket quarantines (SLA_PRIORITY_MISSING). See docs/operations.md."
  );
}
console.log();

if (rows.some((r) => !r.ok)) process.exitCode = 1;
