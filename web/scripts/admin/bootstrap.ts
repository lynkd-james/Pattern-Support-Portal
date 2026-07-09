// =============================================================================
// Admin bootstrap — establish the FIRST administrator (Stage 10a).
//
// Admin authority is NEVER granted automatically by email domain or Entra
// tenant membership (authentication proves identity; an admin_users row grants
// authority). This one-time controlled helper inserts the initial admin_users
// record. Thereafter, admins manage admins through the admin interface (a
// future stage).
//
// Usage (from web/):
//   npm run admin:bootstrap -- --email you@pattern.co.za \
//     --tenant <PATTERN_ENTRA_TENANT_GUID> --name "Your Name"
//
// The tenant GUID is Pattern's own Entra tenant (issuer_namespace pinned at
// provisioning). subject_identifier is left NULL and binds on first login.
// Idempotent: re-running for the same email updates the provisioning fields
// (never touches an already-bound subject_identifier).
// =============================================================================

import "dotenv/config";

import { env } from "../../src/server/env";
import { closePool, query } from "../../src/server/db";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const GUID_RE = /^[0-9a-fA-F-]{36}$/;

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }
  const email = arg("--email");
  const tenant = arg("--tenant");
  const name = arg("--name") ?? null;

  if (!email || !email.includes("@")) {
    throw new Error("Missing/invalid --email <staff email>.");
  }
  if (!tenant || !GUID_RE.test(tenant)) {
    throw new Error("Missing/invalid --tenant <Pattern Entra tenant GUID (36 chars)>.");
  }

  // Insert or re-provision by email. Deliberately does NOT overwrite a bound
  // subject_identifier (that would silently re-open a takeover window; use the
  // rebind runbook instead). role stays 'admin' (single role in V1).
  const res = await query<{ id: string; subject_identifier: string | null }>(
    `INSERT INTO admin_users (email, display_name, identity_provider, issuer_namespace, role, is_active)
       VALUES ($1::citext, $2, 'entra', $3, 'admin', TRUE)
     ON CONFLICT (email) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, admin_users.display_name),
           issuer_namespace = EXCLUDED.issuer_namespace,
           is_active = TRUE,
           updated_at = now()
     RETURNING id, subject_identifier`,
    [email, name, tenant]
  );
  const row = res.rows[0];

  console.log("\nAdmin bootstrap\n───────────────");
  console.log(`email            : ${email}`);
  console.log(`tenant (pinned)  : ${tenant}`);
  console.log(`admin_users id   : ${row.id}`);
  console.log(`bound subject    : ${row.subject_identifier ?? "(none yet — binds on first login)"}`);
  console.log("role             : admin");
  console.log("active           : true");
  console.log(
    "\nNext: sign in via the admin portal with this identity in Pattern's Entra tenant.\n"
  );
}

main()
  .catch((err) => {
    console.error("[admin:bootstrap] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
