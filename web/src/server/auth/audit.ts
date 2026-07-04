// =============================================================================
// Login auditing (server-only, Stage 8a).
//
// Every admitted AND denied login writes an audit_events row
// (change_source = 'PORTAL'). Denials record the token's tid, the internal
// reason code and a truncated hash of the claimed email — repeated denials
// from an unknown tid are attack telemetry (Amendment 1). The client-facing
// response stays information-free; detail lives here and in server logs only.
// =============================================================================

import { query } from "../db";
import { emailTelemetryHash, type LoginDenyReason } from "./identity";

/** audit_events.entity_id is NOT NULL; used when no portal user matched. */
const UNKNOWN_ENTITY = "00000000-0000-0000-0000-000000000000";

export async function auditLoginDenied(args: {
  tid: string | null;
  reason: LoginDenyReason;
  claimedEmail: string | null;
  userId?: string | null;
  accountId?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO audit_events
       (entity_type, entity_id, account_id, field, old_value, new_value, change_source, actor)
     VALUES ('portal_user', $1, $2, 'login_denied', NULL, $3::jsonb, 'PORTAL', 'portal')`,
    [
      args.userId ?? UNKNOWN_ENTITY,
      args.accountId ?? null,
      JSON.stringify({
        tid: args.tid,
        reason: args.reason,
        emailHash: emailTelemetryHash(args.claimedEmail),
      }),
    ]
  );
}

export async function auditLoginAdmitted(args: {
  userId: string;
  accountId: string;
  tid: string;
  bound: boolean; // true when this login performed the first-login oid binding
}): Promise<void> {
  await query(
    `INSERT INTO audit_events
       (entity_type, entity_id, account_id, field, old_value, new_value, change_source, actor)
     VALUES ('portal_user', $1, $2, 'login', NULL, $3::jsonb, 'PORTAL', 'portal')`,
    [args.userId, args.accountId, JSON.stringify({ tid: args.tid, bound: args.bound })]
  );
}
